"""
NAXIONAI — Governance API (Phase 4)

Constraints are entered directly here rather than auto-extracted from a
pasted policy document by an LLM — see governance.py's module docstring for
that scope decision.
"""

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, GovernancePolicy, GovernanceConstraint
from auth import get_current_user
import governance as gov

router = APIRouter(prefix="/api/governance", tags=["governance"])


class ConstraintOut(BaseModel):
    id: str
    rule: str
    severity: str
    category: str
    details: Optional[str] = None
    reviewed: bool
    accepted: bool


def _constraint_out(c: GovernanceConstraint) -> ConstraintOut:
    return ConstraintOut(id=c.id, rule=c.rule, severity=c.severity, category=c.category,
                          details=c.details, reviewed=c.reviewed, accepted=c.accepted)


class PolicyOut(BaseModel):
    id: str
    name: str
    body: str
    is_reference: bool
    constraints: List[ConstraintOut]


@router.get("/", response_model=List[PolicyOut])
async def list_policies(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    policies = (await db.execute(select(GovernancePolicy).where(GovernancePolicy.owner_id == user.get("sub")))).scalars().all()
    out = []
    for p in policies:
        constraints = (await db.execute(select(GovernanceConstraint).where(GovernanceConstraint.policy_id == p.id))).scalars().all()
        out.append(PolicyOut(id=p.id, name=p.name, body=p.body, is_reference=p.is_reference,
                              constraints=[_constraint_out(c) for c in constraints]))
    return out


class CreatePolicyRequest(BaseModel):
    name: str
    body: str
    is_reference: bool = False


@router.post("/", response_model=PolicyOut)
async def create_policy(body: CreatePolicyRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = GovernancePolicy(id=str(uuid.uuid4()), owner_id=user.get("sub"), name=body.name, body=body.body, is_reference=body.is_reference)
    db.add(row)
    await db.commit()
    return PolicyOut(id=row.id, name=row.name, body=row.body, is_reference=row.is_reference, constraints=[])


@router.delete("/{policy_id}")
async def delete_policy(policy_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(GovernancePolicy).where(GovernancePolicy.id == policy_id))).scalars().first()
    if not row or row.owner_id != user.get("sub"):
        raise HTTPException(404, "Policy not found")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted"}


class CreateConstraintRequest(BaseModel):
    rule: str
    severity: str = "soft"
    category: str = "other"
    details: Optional[str] = None


@router.post("/{policy_id}/constraints", response_model=ConstraintOut)
async def create_constraint(policy_id: str, body: CreateConstraintRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    if body.severity not in ("hard", "soft"):
        raise HTTPException(400, "severity must be hard or soft")
    policy = (await db.execute(select(GovernancePolicy).where(GovernancePolicy.id == policy_id))).scalars().first()
    if not policy or policy.owner_id != user.get("sub"):
        raise HTTPException(404, "Policy not found")
    row = GovernanceConstraint(id=str(uuid.uuid4()), policy_id=policy_id, rule=body.rule,
                                severity=body.severity, category=body.category, details=body.details)
    db.add(row)
    await db.commit()
    return _constraint_out(row)


class UpdateConstraintRequest(BaseModel):
    reviewed: Optional[bool] = None
    accepted: Optional[bool] = None
    severity: Optional[str] = None
    category: Optional[str] = None


@router.patch("/constraints/{constraint_id}", response_model=ConstraintOut)
async def update_constraint(constraint_id: str, body: UpdateConstraintRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(GovernanceConstraint).where(GovernanceConstraint.id == constraint_id))).scalars().first()
    if not row:
        raise HTTPException(404, "Constraint not found")
    policy = (await db.execute(select(GovernancePolicy).where(GovernancePolicy.id == row.policy_id))).scalars().first()
    if not policy or policy.owner_id != user.get("sub"):
        raise HTTPException(404, "Constraint not found")
    if body.reviewed is not None:
        row.reviewed = body.reviewed
    if body.accepted is not None:
        row.accepted = body.accepted
    if body.severity is not None:
        if body.severity not in ("hard", "soft"):
            raise HTTPException(400, "severity must be hard or soft")
        row.severity = body.severity
    if body.category is not None:
        row.category = body.category
    await db.commit()
    return _constraint_out(row)


class CheckActionRequest(BaseModel):
    action: str


class CheckActionResponse(BaseModel):
    blocked: bool
    violations: List[dict]


@router.post("/check-action", response_model=CheckActionResponse)
async def check_action(body: CheckActionRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    """Manual test box — mirrors the review-workbench check neuroworks
    exposes on its Governance page."""
    rows = (await db.execute(
        select(GovernanceConstraint, GovernancePolicy.name)
        .join(GovernancePolicy, GovernanceConstraint.policy_id == GovernancePolicy.id)
        .where(GovernancePolicy.owner_id == user.get("sub"))
    )).all()
    constraints = [
        {"id": c.id, "policy_name": policy_name, "rule": c.rule, "severity": c.severity,
         "category": c.category, "reviewed": c.reviewed, "accepted": c.accepted}
        for c, policy_name in rows
    ]
    enforceable = gov.filter_enforceable(constraints)
    result = gov.gate_action(body.action, enforceable)
    return CheckActionResponse(**result)
