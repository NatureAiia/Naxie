"""
NAXIONAI — Personas API

Phase 3a: data models + CRUD. Phase 3b: activation. An "active" persona
folds its voice/responsibilities into the Naxie chat synthesis prompt as
additional context (see api/chat.py) — there's no separate execution path
or per-persona tool routing; naxionai's LangGraph agent graph runs exactly
as it did before, just with different framing text when a persona is live.
"""

import json
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, Persona, AgencySettings
from auth import get_current_user, layer_of_role

router = APIRouter(prefix="/api/personas", tags=["personas"])


class PersonaOut(BaseModel):
    id: str
    slug: str
    name: str
    role: str
    description: str
    job_description: str
    tone: str
    responsibilities: List[str]
    system_prompt_override: Optional[str] = None
    work_mode: str
    language: Optional[str] = None
    is_builtin: bool


def _out(p: Persona) -> PersonaOut:
    return PersonaOut(
        id=p.id, slug=p.slug, name=p.name, role=p.role, description=p.description,
        job_description=p.job_description, tone=p.tone,
        responsibilities=json.loads(p.responsibilities) if p.responsibilities else [],
        system_prompt_override=p.system_prompt_override, work_mode=p.work_mode,
        language=p.language, is_builtin=p.is_builtin,
    )


def _is_admin(user) -> bool:
    return layer_of_role((user or {}).get("role")) in ("admin", "superadmin")


async def _find(db: AsyncSession, persona_id: str) -> Optional[Persona]:
    """Look up by UUID `id` or by the stable catalog `slug` (e.g. "clawbot")
    — clients referencing a well-known built-in know its slug, not its
    randomly-generated id."""
    return (await db.execute(
        select(Persona).where(or_(Persona.id == persona_id, Persona.slug == persona_id))
    )).scalars().first()


@router.get("/", response_model=List[PersonaOut])
async def list_personas(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    """Built-ins (owner_id is null) plus the caller's own custom hires."""
    rows = (await db.execute(
        select(Persona).where(or_(Persona.is_builtin == True, Persona.owner_id == user.get("sub")))  # noqa: E712
    )).scalars().all()
    return [_out(p) for p in rows]


async def _get_or_create_settings(db: AsyncSession, user_id: str) -> AgencySettings:
    row = (await db.execute(select(AgencySettings).where(AgencySettings.user_id == user_id))).scalars().first()
    if row is None:
        row = AgencySettings(id=str(uuid.uuid4()), user_id=user_id)
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


@router.get("/active", response_model=Optional[PersonaOut])
async def get_active_persona(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    settings = await _get_or_create_settings(db, user.get("sub"))
    if not settings.active_persona_id:
        return None
    p = await _find(db, settings.active_persona_id)
    return _out(p) if p else None


@router.post("/deactivate")
async def deactivate_persona(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    settings = await _get_or_create_settings(db, user.get("sub"))
    settings.active_persona_id = None
    await db.commit()
    return {"status": "deactivated"}


@router.get("/{persona_id}", response_model=PersonaOut)
async def get_persona(persona_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    p = await _find(db, persona_id)
    if not p or (not p.is_builtin and p.owner_id != user.get("sub") and not _is_admin(user)):
        raise HTTPException(404, "Persona not found")
    return _out(p)


class CreatePersonaRequest(BaseModel):
    name: str
    role: str
    description: str = ""
    job_description: str = ""
    tone: str = "professional"
    responsibilities: List[str] = []
    system_prompt_override: Optional[str] = None
    work_mode: str = "agent"
    language: Optional[str] = None


def _slugify(name: str) -> str:
    import re
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return (s or "persona")[:60]


@router.post("/", response_model=PersonaOut)
async def create_persona(body: CreatePersonaRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    if body.work_mode not in ("agent", "hybrid", "human"):
        raise HTTPException(400, "work_mode must be agent, hybrid, or human")
    base_slug = _slugify(body.name)
    slug = base_slug
    suffix = 1
    while (await db.execute(select(Persona).where(Persona.slug == slug))).scalars().first():
        suffix += 1
        slug = f"{base_slug}-{suffix}"
    row = Persona(
        id=str(uuid.uuid4()), slug=slug, owner_id=user.get("sub"), name=body.name, role=body.role,
        description=body.description, job_description=body.job_description, tone=body.tone,
        responsibilities=json.dumps(body.responsibilities),
        system_prompt_override=body.system_prompt_override,
        work_mode=body.work_mode, language=body.language, is_builtin=False,
    )
    db.add(row)
    await db.commit()
    return _out(row)


class UpdatePersonaRequest(BaseModel):
    work_mode: Optional[str] = None
    tone: Optional[str] = None
    description: Optional[str] = None
    role: Optional[str] = None
    system_prompt_override: Optional[str] = None
    language: Optional[str] = None


@router.patch("/{persona_id}", response_model=PersonaOut)
async def update_persona(persona_id: str, body: UpdatePersonaRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    """Built-ins accept edits too (mirrors updatePersona) — e.g. parking the
    built-in Researcher as work_mode="human" is a legitimate org decision."""
    p = await _find(db, persona_id)
    if not p or (not p.is_builtin and p.owner_id != user.get("sub") and not _is_admin(user)):
        raise HTTPException(404, "Persona not found")
    if body.work_mode is not None:
        if body.work_mode not in ("agent", "hybrid", "human"):
            raise HTTPException(400, "work_mode must be agent, hybrid, or human")
        p.work_mode = body.work_mode
    if body.tone:
        p.tone = body.tone
    if body.description is not None:
        p.description = body.description
    if body.role:
        p.role = body.role
    if body.system_prompt_override is not None:
        p.system_prompt_override = body.system_prompt_override or None
    if body.language is not None:
        p.language = body.language or None
    await db.commit()
    return _out(p)


@router.delete("/{persona_id}")
async def delete_persona(persona_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    """Built-ins can't be deleted — stable identities referenced elsewhere
    (mirrors deletePersona's guard)."""
    p = await _find(db, persona_id)
    if not p or (p.owner_id != user.get("sub") and not _is_admin(user)):
        raise HTTPException(404, "Persona not found")
    if p.is_builtin:
        raise HTTPException(400, "Built-in personas can't be deleted")
    await db.delete(p)
    await db.commit()
    return {"status": "deleted"}


@router.post("/{persona_id}/activate", response_model=PersonaOut)
async def activate_persona(persona_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    p = await _find(db, persona_id)
    if not p or (not p.is_builtin and p.owner_id != user.get("sub") and not _is_admin(user)):
        raise HTTPException(404, "Persona not found")
    settings = await _get_or_create_settings(db, user.get("sub"))
    settings.active_persona_id = p.id
    await db.commit()
    return _out(p)
