"""
NAXIONAI — Departments API (Phase 3a: data models + CRUD only)

Built-in DEPARTMENT_TEMPLATES (org_catalog.py) are static data; operator-
created departments live in the `departments` table. Both surface through
this listing so the frontend doesn't need to care which is which — mirrors
custom-departments.ts's customToListRow() unification.
"""

import json
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, Department, DepartmentDatum
from auth import get_current_user, layer_of_role
import org_catalog

router = APIRouter(prefix="/api/departments", tags=["departments"])


class DepartmentListRow(BaseModel):
    id: str
    name: str
    tagline: str
    description: str
    icon: str
    color: str
    agent_count: int
    integration_count: int
    has_schedule: bool
    workflow_steps: int
    custom: bool


def _template_to_row(t: org_catalog.DepartmentTemplateDef) -> DepartmentListRow:
    return DepartmentListRow(
        id=t.id, name=t.name, tagline=t.tagline, description=t.description,
        icon=t.icon, color=t.color, agent_count=len(t.agents),
        integration_count=len(t.recommended_integrations),
        has_schedule=t.schedule is not None, workflow_steps=len(t.workflow),
        custom=False,
    )


def _row_to_row(d: Department) -> DepartmentListRow:
    roles = json.loads(d.roles) if d.roles else []
    return DepartmentListRow(
        id=d.id, name=d.name, tagline=d.tagline, description=d.description,
        icon=d.icon, color=d.color, agent_count=len(roles),
        integration_count=0, has_schedule=False, workflow_steps=0, custom=True,
    )


@router.get("/", response_model=List[DepartmentListRow])
async def list_departments(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    custom = (await db.execute(
        select(Department).where(Department.owner_id == user.get("sub"))
    )).scalars().all()
    return [_template_to_row(t) for t in org_catalog.DEPARTMENT_TEMPLATES] + [_row_to_row(d) for d in custom]


@router.get("/{department_id}")
async def get_department(department_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    template = next((t for t in org_catalog.DEPARTMENT_TEMPLATES if t.id == department_id), None)
    if template:
        return template
    d = (await db.execute(select(Department).where(Department.id == department_id))).scalars().first()
    if not d or d.owner_id != user.get("sub"):
        raise HTTPException(404, "Department not found")
    return _row_to_row(d)


class CreateDepartmentRequest(BaseModel):
    name: str
    tagline: str = "Custom department"
    description: str = ""
    icon: str = "Building2"
    color: str = "violet"
    roles: List[str] = []


@router.post("/", response_model=DepartmentListRow)
async def create_department(body: CreateDepartmentRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name is required")
    row = Department(
        id=str(uuid.uuid4()), owner_id=user.get("sub"), name=name[:80],
        tagline=(body.tagline.strip() or "Custom department")[:160],
        description=(body.description.strip() or f"The {name} department.")[:1000],
        icon=(body.icon.strip() or "Building2")[:40], color=(body.color.strip() or "violet")[:40],
        roles=json.dumps([r.strip() for r in body.roles if r.strip()][:20]),
    )
    db.add(row)
    await db.commit()
    return _row_to_row(row)


@router.delete("/{department_id}")
async def delete_department(department_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    d = (await db.execute(select(Department).where(Department.id == department_id))).scalars().first()
    if not d or d.owner_id != user.get("sub"):
        raise HTTPException(404, "Department not found (built-in templates can't be deleted)")
    await db.delete(d)
    await db.commit()
    return {"status": "deleted"}


# ─── Department data (lightweight per-department reference facts) ───

class DepartmentDatumOut(BaseModel):
    id: str
    department: str
    title: str
    content: str


def _datum_out(d: DepartmentDatum) -> DepartmentDatumOut:
    return DepartmentDatumOut(id=d.id, department=d.department, title=d.title, content=d.content)


@router.get("/data/list", response_model=List[DepartmentDatumOut])
async def list_department_data(department: Optional[str] = None, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    stmt = select(DepartmentDatum).where(DepartmentDatum.owner_id == user.get("sub"))
    if department:
        stmt = stmt.where(DepartmentDatum.department == department.strip())
    rows = (await db.execute(stmt.order_by(DepartmentDatum.department, DepartmentDatum.title))).scalars().all()
    return [_datum_out(d) for d in rows]


class CreateDepartmentDatumRequest(BaseModel):
    department: str
    title: str
    content: str


@router.post("/data", response_model=DepartmentDatumOut)
async def create_department_datum(body: CreateDepartmentDatumRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    department = " ".join(body.department.split())
    title = body.title.strip()[:120]
    content = body.content.strip()[:20000]
    if not department or not title or not content:
        raise HTTPException(400, "department, title, and content are all required")
    row = DepartmentDatum(id=str(uuid.uuid4()), owner_id=user.get("sub"), department=department, title=title, content=content)
    db.add(row)
    await db.commit()
    return _datum_out(row)


@router.delete("/data/{datum_id}")
async def delete_department_datum(datum_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    d = (await db.execute(select(DepartmentDatum).where(DepartmentDatum.id == datum_id))).scalars().first()
    if not d or d.owner_id != user.get("sub"):
        raise HTTPException(404, "Not found")
    await db.delete(d)
    await db.commit()
    return {"status": "deleted"}
