"""
NAXIONAI — Personal knowledge vault API (Phase 6).
Ported from neuroworks/server/src/routes/brain.ts (trimmed to the core
read/write/search/sync surface — see vault.py for what's in/out of scope).
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_current_user
import vault

router = APIRouter(prefix="/api/vault", tags=["vault"])


@router.get("/health")
async def health(user: dict = Depends(get_current_user)):
    return vault.get_vault_health()


@router.get("/tree")
async def tree(path: str = "", user: dict = Depends(get_current_user)):
    try:
        return {"nodes": vault.list_vault(path)}
    except vault.VaultUnreachable as e:
        raise HTTPException(503, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.get("/file")
async def read_file(path: str, user: dict = Depends(get_current_user)):
    try:
        return {"path": path, "content": vault.read_vault_file(path)}
    except vault.VaultUnreachable as e:
        raise HTTPException(503, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "file not found")


class WriteFileRequest(BaseModel):
    path: str
    content: str


@router.put("/file")
async def write_file(body: WriteFileRequest, user: dict = Depends(get_current_user)):
    try:
        vault.write_vault_file(body.path, body.content)
        return {"ok": True}
    except vault.VaultUnreachable as e:
        raise HTTPException(503, str(e))
    except vault.VaultSecurityRefusal as e:
        raise HTTPException(422, {"error": str(e), "findings": e.findings})
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.get("/search")
async def search(q: str, limit: int = 50, filenames_only: bool = False, user: dict = Depends(get_current_user)):
    try:
        hits = vault.search_vault_filenames(q, limit) if filenames_only else vault.search_vault(q, limit)
        return {"hits": [{"path": h.path, "line": h.line, "preview": h.preview} for h in hits]}
    except vault.VaultUnreachable as e:
        raise HTTPException(503, str(e))


@router.post("/reindex")
async def reindex(user: dict = Depends(get_current_user)):
    vault.build_index()
    return {"ok": True}


class SyncRequest(BaseModel):
    message: Optional[str] = None


@router.post("/sync")
async def sync(body: SyncRequest, user: dict = Depends(get_current_user)):
    message = body.message or "Update from Naxie"
    return vault.commit_and_push(message)


@router.post("/pull")
async def pull(user: dict = Depends(get_current_user)):
    return vault.pull_from_origin()


@router.get("/status")
async def status(user: dict = Depends(get_current_user)):
    return {"ahead_by": vault.vault_ahead_by()}
