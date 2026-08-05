"""
NAXIONAI — Teams API (Phase 3a: data models + CRUD only)

BUILTIN_TEAMS and BUILTIN_TEAM_TEMPLATES (org_catalog.py) are static, exactly
like department templates. Operator-saved briefs live in `team_templates`.

/preview-* endpoints expand a team/template + objective into per-persona task
text (pure string templating, ported from teams.ts's buildTasksForTeam /
buildTasksForTemplate) — they do NOT create AgentTasks or touch the LangGraph
graph. Actually dispatching a team as running work is Phase 3b (needs the
persona-execution design spike), not implemented here.
"""

import re
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, TeamTemplate
from auth import get_current_user
import org_catalog

router = APIRouter(prefix="/api/teams", tags=["teams"])


class TeamMemberOut(BaseModel):
    persona_id: str
    role: str


class TeamOut(BaseModel):
    id: str
    name: str
    description: str
    members: List[TeamMemberOut]


@router.get("/", response_model=List[TeamOut])
async def list_teams():
    return [
        TeamOut(id=t.id, name=t.name, description=t.description,
                members=[TeamMemberOut(persona_id=m.persona_id, role=m.role) for m in t.members])
        for t in org_catalog.BUILTIN_TEAMS
    ]


@router.get("/{team_id}", response_model=TeamOut)
async def get_team(team_id: str):
    t = next((t for t in org_catalog.BUILTIN_TEAMS if t.id == team_id), None)
    if not t:
        raise HTTPException(404, "Team not found")
    return TeamOut(id=t.id, name=t.name, description=t.description,
                   members=[TeamMemberOut(persona_id=m.persona_id, role=m.role) for m in t.members])


class TeamTaskOut(BaseModel):
    persona: str
    content: str


@router.post("/{team_id}/preview-tasks", response_model=List[TeamTaskOut])
async def preview_team_tasks(team_id: str, objective: str):
    """Expand a pre-org team + objective into per-member tasks, each framed
    for the member's role (ports buildTasksForTeam — pure string templating,
    no execution)."""
    t = next((t for t in org_catalog.BUILTIN_TEAMS if t.id == team_id), None)
    if not t:
        raise HTTPException(404, "Team not found")
    obj = objective.strip()
    return [
        TeamTaskOut(persona=m.persona_id, content=f"{obj}\n\n(Contribute the part that fits your role as {m.role}. Produce your slice of this objective; assume teammates cover the rest.)")
        for m in t.members
    ]


# ─── Team-brief templates ───

class TeamTemplateTaskOut(BaseModel):
    persona: str
    content: str


class TeamTemplateOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    team_id: Optional[str] = None
    tasks: List[TeamTemplateTaskOut]
    is_builtin: bool


async def _all_templates(db: AsyncSession, owner_id: str) -> List[TeamTemplateOut]:
    builtin = [
        TeamTemplateOut(id=t.id, name=t.name, description=t.description, team_id=t.team_id,
                         tasks=[TeamTemplateTaskOut(persona=x.persona, content=x.content) for x in t.tasks],
                         is_builtin=True)
        for t in org_catalog.BUILTIN_TEAM_TEMPLATES
    ]
    rows = (await db.execute(select(TeamTemplate).where(TeamTemplate.owner_id == owner_id))).scalars().all()
    import json as _json
    custom = [
        TeamTemplateOut(id=r.id, name=r.name, description=r.description, team_id=r.team_id,
                         tasks=[TeamTemplateTaskOut(**x) for x in _json.loads(r.tasks)], is_builtin=False)
        for r in rows
    ]
    return builtin + custom


@router.get("/templates/", response_model=List[TeamTemplateOut])
async def list_team_templates(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    return await _all_templates(db, user.get("sub"))


@router.post("/templates/{template_id}/preview-tasks", response_model=List[TeamTaskOut])
async def preview_template_tasks(template_id: str, objective: str = "", db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    """Ports buildTasksForTemplate — substitutes {{objective}} into each
    saved task, defaulting to a generic phrase when none is given."""
    templates = await _all_templates(db, user.get("sub"))
    tpl = next((t for t in templates if t.id == template_id), None)
    if not tpl:
        raise HTTPException(404, "Template not found")
    obj = objective.strip() or "the stated objective"
    return [TeamTaskOut(persona=t.persona, content=re.sub(r"\{\{\s*objective\s*\}\}", obj, t.content, flags=re.IGNORECASE)) for t in tpl.tasks]


class CreateTeamTemplateRequest(BaseModel):
    name: str
    description: Optional[str] = None
    team_id: Optional[str] = None
    tasks: List[TeamTemplateTaskOut]


@router.post("/templates", response_model=TeamTemplateOut)
async def create_team_template(body: CreateTeamTemplateRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    import json as _json
    row = TeamTemplate(
        id=str(uuid.uuid4()), owner_id=user.get("sub"), name=body.name, description=body.description,
        team_id=body.team_id, tasks=_json.dumps([t.model_dump() for t in body.tasks]),
    )
    db.add(row)
    await db.commit()
    return TeamTemplateOut(id=row.id, name=row.name, description=row.description, team_id=row.team_id, tasks=body.tasks, is_builtin=False)


@router.delete("/templates/{template_id}")
async def delete_team_template(template_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(TeamTemplate).where(TeamTemplate.id == template_id))).scalars().first()
    if not row or row.owner_id != user.get("sub"):
        raise HTTPException(404, "Template not found (built-in templates can't be deleted)")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted"}
