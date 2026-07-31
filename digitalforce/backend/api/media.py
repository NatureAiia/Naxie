"""Digital Force — Media Library API"""
import json, uuid, logging
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from database import get_db, MediaAsset
from auth import get_current_user
from config import get_settings

router = APIRouter(prefix="/api/media", tags=["media"])
logger = logging.getLogger(__name__)
settings = get_settings()
UPLOAD_DIR = Path(settings.media_upload_dir)

IMAGE_TYPES = {"png", "jpg", "jpeg", "webp", "gif"}
VIDEO_TYPES = {"mp4", "mov", "avi", "webm"}
AUDIO_TYPES = {"mp3", "wav", "m4a"}
DOC_TYPES = {"pdf", "docx", "doc"}

MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB cap; streamed to disk in chunks


def _is_admin(user) -> bool:
    return (user or {}).get("role") in ("admin", "superadmin")

@router.post("/upload")
async def upload_media(
    file: UploadFile = File(...),
    tags: str = Form("[]"),
    alt_text: str = Form(""),
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    safe_name = Path(file.filename or "upload").name
    ext = Path(safe_name).suffix.lstrip(".").lower()
    asset_type = ("image" if ext in IMAGE_TYPES else "video" if ext in VIDEO_TYPES
                  else "audio" if ext in AUDIO_TYPES else "pdf" if ext == "pdf" else "document")

    asset_id = str(uuid.uuid4())
    filename = f"{asset_id}_{safe_name}"
    dest = UPLOAD_DIR / filename
    # Stream to disk in chunks with a hard size cap, instead of buffering the
    # whole file in memory (memory spike + event-loop stall on large uploads).
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(413, f"File exceeds the {MAX_UPLOAD_BYTES // (1024*1024)} MB upload limit")
                out.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        dest.unlink(missing_ok=True)
        logger.error("Upload write failed for %s: %s", filename, e)
        raise HTTPException(500, "Upload failed")

    asset = MediaAsset(
        id=asset_id, filename=filename, original_filename=file.filename,
        file_path=str(dest), public_url=f"/media/{filename}",
        file_size_bytes=dest.stat().st_size, mime_type=file.content_type or f"application/{ext}",
        asset_type=asset_type, manual_tags=tags, alt_text=alt_text,
        uploaded_by=user.get("sub"),
    )

    # Auto-tag with Vision if image
    if asset_type == "image" and (settings.groq_api_key_1 or settings.groq_api_key_2 or settings.groq_api_key_3):
        try:
            from rag.pipeline import parse_image
            description = await parse_image(str(dest))
            asset.ai_description = description[:1000]
        except Exception as e:
            logger.warning(f"Auto-tagging failed: {e}")

    db.add(asset)
    await db.flush()
    return {"id": asset_id, "url": f"/media/{filename}", "type": asset_type, "filename": file.filename}


@router.get("")
async def list_media(asset_type: str = None, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    # Filter in SQL (before the limit) and scope to the caller's own assets;
    # admins see all. Applying asset_type after .limit(200) previously dropped
    # valid rows and leaked every user's library.
    q = select(MediaAsset)
    if asset_type:
        q = q.where(MediaAsset.asset_type == asset_type)
    if not _is_admin(user):
        q = q.where(MediaAsset.uploaded_by == user.get("sub"))
    q = q.order_by(desc(MediaAsset.created_at)).limit(200)
    result = await db.execute(q)
    assets = result.scalars().all()
    items = [{
        "id": a.id, "filename": a.original_filename, "url": a.public_url,
        "type": a.asset_type, "size": a.file_size_bytes,
        "tags": json.loads(a.manual_tags or "[]"),
        "auto_tags": json.loads(a.auto_tags or "[]"),
        "ai_description": a.ai_description,
        "usage_count": a.usage_count,
        "created_at": a.created_at.isoformat(),
    } for a in assets]
    return items


@router.delete("/{asset_id}")
async def delete_media(asset_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    asset = await db.get(MediaAsset, asset_id)
    if not asset:
        raise HTTPException(404, "Asset not found")
    if not _is_admin(user) and asset.uploaded_by != user.get("sub"):
        raise HTTPException(404, "Asset not found")
    try:
        Path(asset.file_path).unlink(missing_ok=True)
    except Exception as e:
        logger.error("OS Exception when deleting media file %s: %s", asset.file_path, str(e), exc_info=True)
    await db.delete(asset)
    return {"deleted": True}
