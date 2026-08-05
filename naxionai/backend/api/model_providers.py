"""
NAXIONAI — Bring-your-own model provider API (Phase 6).
Ported from neuroworks/server/src/lib/model-providers.ts. See model_providers.py
for the runtime cascade integration; this is just the CRUD surface.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
import model_providers as mp

router = APIRouter(prefix="/api/model-providers", tags=["model-providers"])


@router.get("/")
async def list_providers(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    return await mp.list_providers(db)


@router.get("/kinds")
async def list_kinds(user: dict = Depends(get_current_user)):
    return mp.PROVIDER_DEFAULTS


class AddProviderRequest(BaseModel):
    kind: str
    model: str
    api_key: str
    label: Optional[str] = None
    base_url: Optional[str] = None
    active: bool = True


@router.post("/")
async def add_provider(body: AddProviderRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    try:
        return await mp.add_provider(
            db, kind=body.kind, model=body.model, api_key=body.api_key,
            label=body.label, base_url=body.base_url, active=body.active,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{provider_id}/activate")
async def activate_provider(provider_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await mp.activate_provider(db, provider_id)
    if not row:
        raise HTTPException(404, "provider not found")
    return row


@router.delete("/{provider_id}")
async def remove_provider(provider_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    ok = await mp.remove_provider(db, provider_id)
    if not ok:
        raise HTTPException(404, "provider not found")
    return {"ok": True}
