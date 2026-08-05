"""
NAXIONAI — Document export API (Phase 6).
Ported from neuroworks/server/src/routes/exports.ts.
"""

import re

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from auth import get_current_user
import document_export
import vault

router = APIRouter(prefix="/api/exports", tags=["exports"])


def _safe_filename(name: str, ext: str) -> str:
    f = re.sub(r'[/\\:*?"<>|]+', "-", name or "document").lstrip(".")
    if not f.lower().endswith(f".{ext}"):
        f += f".{ext}"
    return f


class ExportRequest(BaseModel):
    markdown: str
    title: str | None = None
    filename: str = "document"


@router.post("/docx")
async def export_docx(body: ExportRequest, user: dict = Depends(get_current_user)):
    if not body.markdown.strip():
        raise HTTPException(400, "markdown is required")
    data = document_export.markdown_to_docx_bytes(body.markdown, body.title or body.filename)
    filename = _safe_filename(body.filename, "docx")
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/pdf")
async def export_pdf(body: ExportRequest, user: dict = Depends(get_current_user)):
    if not body.markdown.strip():
        raise HTTPException(400, "markdown is required")
    try:
        data = await document_export.markdown_to_pdf_bytes(body.markdown, body.title or body.filename)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    filename = _safe_filename(body.filename, "pdf")
    return Response(content=data, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/docx")
async def export_docx_from_vault(path: str, user: dict = Depends(get_current_user)):
    markdown_text = _read_vault_markdown(path)
    data = document_export.markdown_to_docx_bytes(markdown_text, path.rsplit("/", 1)[-1])
    filename = _safe_filename(path.rsplit("/", 1)[-1], "docx")
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/pdf")
async def export_pdf_from_vault(path: str, user: dict = Depends(get_current_user)):
    markdown_text = _read_vault_markdown(path)
    try:
        data = await document_export.markdown_to_pdf_bytes(markdown_text, path.rsplit("/", 1)[-1])
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    filename = _safe_filename(path.rsplit("/", 1)[-1], "pdf")
    return Response(content=data, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _read_vault_markdown(path: str) -> str:
    if not re.search(r"\.(md|markdown|txt)$", path, re.I):
        raise HTTPException(400, "only .md / .txt files can be exported")
    try:
        return vault.read_vault_file(path)
    except vault.VaultUnreachable as e:
        raise HTTPException(503, str(e))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "file not found")
