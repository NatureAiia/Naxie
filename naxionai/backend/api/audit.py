"""
NAXIONAI — Audit log API (Phase 4)

Reads the same AgentLog table goals.py/stream.py already write to (see
database.py's audit-fields note on AgentLog) — this just exposes a global,
cross-goal view instead of the existing per-goal listings.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, AgentLog, Goal
from auth import get_current_user, layer_of_role

router = APIRouter(prefix="/api/audit", tags=["audit"])


def _is_admin(user) -> bool:
    return layer_of_role((user or {}).get("role")) in ("admin", "superadmin")


class AuditEventOut(BaseModel):
    id: str
    goal_id: Optional[str] = None
    agent: str
    level: str
    action: Optional[str] = None
    target: Optional[str] = None
    result: Optional[str] = None
    observation: Optional[str] = None
    created_at: str


@router.get("/", response_model=List[AuditEventOut])
async def list_audit_events(
    limit: int = Query(100, ge=1, le=500),
    level: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    stmt = select(AgentLog).order_by(desc(AgentLog.created_at)).limit(limit)
    if level:
        stmt = stmt.where(AgentLog.level == level)
    if not _is_admin(user):
        # Non-admins only see logs tied to a goal they created — matches
        # _require_goal_access's ownership rule in api/goals.py. Logs with
        # no goal_id (e.g. chat-level thoughts) aren't attributable to a
        # single user, so they're excluded rather than shown to everyone.
        stmt = stmt.join(Goal, AgentLog.goal_id == Goal.id).where(Goal.created_by == user.get("sub"))
    rows = (await db.execute(stmt)).scalars().all()
    return [
        AuditEventOut(
            id=r.id, goal_id=r.goal_id, agent=r.agent, level=r.level, action=r.action,
            target=r.target, result=r.result, observation=r.observation,
            created_at=r.created_at.isoformat(),
        )
        for r in rows
    ]
