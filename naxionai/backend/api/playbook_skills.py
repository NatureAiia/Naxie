"""
NAXIONAI — Playbook Skills API (Phase 2)

Distinct namespace from /api/skills (SkillForge, unchanged) — see
playbook_matcher.py's module docstring for why these are two separate
concepts rather than one merged table.
"""

import json
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, PlaybookSkill
from auth import get_current_user
import playbook_matcher as matcher

router = APIRouter(prefix="/api/skills/playbooks", tags=["playbook-skills"])


class PlaybookOut(BaseModel):
    name: str
    description: str
    applies_to: List[str]
    source: str
    body: Optional[str] = None


class CreatePlaybookRequest(BaseModel):
    name: str
    description: str
    applies_to: List[str] = []
    body: str


def _row_to_def(row: PlaybookSkill) -> matcher.PlaybookSkillDef:
    return matcher.PlaybookSkillDef(
        name=row.name,
        description=row.description,
        applies_to=json.loads(row.applies_to) if row.applies_to else [],
        body=row.body,
        source=row.source,
    )


async def get_all_playbook_skills(db: AsyncSession, user: dict) -> List[matcher.PlaybookSkillDef]:
    """Builtin playbooks + the caller's own user-authored overrides. A user
    row wins over a builtin with the same name (mirrors skills.ts's
    loadSkill(): user-source wins on a name collision)."""
    builtin = matcher.load_builtin_skills()
    rows = (await db.execute(
        select(PlaybookSkill).where(PlaybookSkill.owner_id == user.get("sub"))
    )).scalars().all()
    user_defs = [_row_to_def(r) for r in rows]
    user_names = {d.name.lower() for d in user_defs}
    return [b for b in builtin if b.name.lower() not in user_names] + user_defs


@router.get("/", response_model=List[PlaybookOut])
async def list_playbooks(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    skills = await get_all_playbook_skills(db, user)
    return [PlaybookOut(name=s.name, description=s.description, applies_to=s.applies_to, source=s.source) for s in skills]


@router.get("/{name}", response_model=PlaybookOut)
async def get_playbook(name: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    skills = await get_all_playbook_skills(db, user)
    target = name.strip().lower()
    match = next((s for s in skills if s.name.lower() == target), None)
    if not match:
        raise HTTPException(404, "Playbook not found")
    return PlaybookOut(name=match.name, description=match.description, applies_to=match.applies_to, source=match.source, body=match.body)


class SuggestRequest(BaseModel):
    task: str
    intent: Optional[str] = None
    limit: int = 2


@router.post("/suggest", response_model=List[PlaybookOut])
async def suggest_playbooks(body: SuggestRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    skills = await get_all_playbook_skills(db, user)
    matches = matcher.suggest_skills_for_task(skills, body.task, body.intent, body.limit)
    return [PlaybookOut(name=s.name, description=s.description, applies_to=s.applies_to, source=s.source) for s in matches]


@router.post("/", response_model=PlaybookOut)
async def create_playbook(body: CreatePlaybookRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    existing = (await db.execute(
        select(PlaybookSkill).where(PlaybookSkill.name == body.name, PlaybookSkill.owner_id == user.get("sub"))
    )).scalars().first()
    if existing:
        raise HTTPException(409, "You already have a playbook with that name")
    row = PlaybookSkill(
        id=str(uuid.uuid4()),
        owner_id=user.get("sub"),
        name=body.name,
        description=body.description,
        applies_to=json.dumps(body.applies_to),
        body=body.body,
        source="user",
    )
    db.add(row)
    await db.commit()
    return PlaybookOut(name=row.name, description=row.description, applies_to=body.applies_to, source=row.source, body=row.body)


@router.delete("/{name}")
async def delete_playbook(name: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(
        select(PlaybookSkill).where(PlaybookSkill.name == name, PlaybookSkill.owner_id == user.get("sub"))
    )).scalars().first()
    if not row:
        raise HTTPException(404, "Playbook not found (only your own overrides can be deleted — builtins are read-only)")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted"}
