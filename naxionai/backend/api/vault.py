"""NAXIONAI — Vault API (file-based knowledge base). See vault.py for the
filesystem + RAG-mirroring implementation."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import vault
from auth import get_current_user

router = APIRouter(prefix="/api/vault", tags=["vault"])
logger = logging.getLogger(__name__)


@router.get("/tree")
async def get_tree(user: dict = Depends(get_current_user)):
    return {"entries": vault.list_tree()}


@router.get("/search")
async def search(q: str, user: dict = Depends(get_current_user)):
    return {"results": vault.search_notes(q)}


@router.get("/notes/{path:path}")
async def get_note(path: str, user: dict = Depends(get_current_user)):
    try:
        return {"path": path, "content": vault.read_note(path)}
    except vault.VaultError as e:
        raise HTTPException(404, str(e))


class SaveNoteRequest(BaseModel):
    path: str
    content: str
    category: str = "vault"


@router.post("/notes")
async def create_note(body: SaveNoteRequest, user: dict = Depends(get_current_user)):
    try:
        result = await vault.save_note(body.path, body.content, uploaded_by=user.get("sub"), category=body.category)
    except vault.VaultError as e:
        raise HTTPException(400, str(e))
    return result
