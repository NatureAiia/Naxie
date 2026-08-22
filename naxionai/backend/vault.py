"""
NAXIONAI — Vault (file-based knowledge base)

Ported concept from neuroworks/server/src/lib/vault.ts / vault-index.ts,
adapted to naxionai's architecture: neuroworks keeps a MiniSearch full-text
index over the vault; naxionai already has a Qdrant-backed RAG pipeline
(rag/pipeline.py, rag/retriever.py) used by every other knowledge feature,
so a written note is additionally mirrored into a `KnowledgeItem` row and
embedded through that SAME pipeline (source_type="text" — rag/pipeline.py's
`ingest()` reads the file at `source_path` for that type) rather than
building a second, parallel search index. Browsing/reading/keyword-searching
the vault itself still works directly off the filesystem, independent of
whether the RAG mirror succeeded.

Path safety: every relative path is resolved against `settings.vault_path`
and rejected if it would land outside that root (the same containment idiom
`api/media.py` uses for uploaded filenames, generalized to nested paths).
"""

import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from config import get_settings

logger = logging.getLogger(__name__)


class VaultError(ValueError):
    pass


def _vault_root() -> Path:
    settings = get_settings()
    root = Path(settings.vault_path).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_path(rel_path: str) -> Path:
    """Resolve a caller-supplied relative path against the vault root and
    reject anything that would escape it (absolute paths, `..` traversal,
    symlink escapes)."""
    if not rel_path or not rel_path.strip():
        raise VaultError("Path cannot be empty")
    root = _vault_root()
    candidate = (root / rel_path.strip().lstrip("/\\")).resolve()
    if candidate != root and root not in candidate.parents:
        raise VaultError(f'"{rel_path}" resolves outside the vault root')
    return candidate


def read_note(rel_path: str) -> str:
    path = _safe_path(rel_path)
    if not path.is_file():
        raise VaultError(f'Note not found: "{rel_path}"')
    return path.read_text(encoding="utf-8")


def write_note(rel_path: str, content: str) -> Path:
    """Write (create or overwrite) a note. Returns the absolute path written."""
    path = _safe_path(rel_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def list_tree() -> list[dict]:
    """Flat listing of every file under the vault, relative to its root."""
    root = _vault_root()
    entries = []
    for p in sorted(root.rglob("*")):
        if p.is_file():
            entries.append({
                "path": str(p.relative_to(root)).replace("\\", "/"),
                "size_bytes": p.stat().st_size,
                "modified_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
            })
    return entries


def search_notes(query: str, limit: int = 20) -> list[dict]:
    """Simple case-insensitive substring/regex scan across every markdown/
    text file — the vault is expected to stay small enough that this beats
    the cost (and new dependency) of a dedicated full-text index."""
    q = (query or "").strip()
    if not q:
        return []
    root = _vault_root()
    try:
        pattern = re.compile(re.escape(q), re.IGNORECASE)
    except re.error:
        return []
    results = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in (".md", ".markdown", ".txt"):
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        match = pattern.search(text)
        if not match:
            continue
        start = max(0, match.start() - 80)
        end = min(len(text), match.end() + 80)
        snippet = text[start:end].replace("\n", " ").strip()
        results.append({"path": str(p.relative_to(root)).replace("\\", "/"), "snippet": snippet})
        if len(results) >= limit:
            break
    return results


async def save_note(rel_path: str, content: str, uploaded_by: Optional[str] = None, category: str = "vault") -> dict:
    """Write a note to disk, then mirror it into KnowledgeItem/Qdrant via the
    existing RAG ingestion pipeline so chat/agent retrieval can find it — the
    same source_type="text" path api/training.py's raw-text upload takes.
    RAG mirroring failure doesn't undo the file write: the note still exists
    and is browsable/keyword-searchable even if embedding failed."""
    import json
    import uuid

    from database import KnowledgeItem, async_session

    path = write_note(rel_path, content)
    root = _vault_root()
    title = path.stem
    item_id = str(uuid.uuid4())

    async with async_session() as db:
        db.add(KnowledgeItem(
            id=item_id, title=title, source_type="text", source_path=str(path),
            category=category, tags=json.dumps(["vault"]), processing_status="processing",
            uploaded_by=uploaded_by,
        ))
        await db.commit()

    try:
        from rag.pipeline import ingest
        result = await ingest(
            source_type="text", source_path=str(path), knowledge_item_id=item_id,
            title=title, category=category, tags=["vault"],
        )
        async with async_session() as db:
            item = await db.get(KnowledgeItem, item_id)
            if item:
                if result.get("success"):
                    item.processing_status = "indexed"
                    item.qdrant_ids = json.dumps(result.get("qdrant_ids", []))
                    item.chunk_count = result.get("chunk_count", 0)
                    item.processed_at = datetime.utcnow()
                else:
                    item.processing_status = "failed"
                    item.error_message = result.get("error", "Unknown error")
                await db.commit()
    except Exception as e:
        logger.warning("[Vault] RAG mirror failed for %s: %s", rel_path, e)
        async with async_session() as db:
            item = await db.get(KnowledgeItem, item_id)
            if item:
                item.processing_status = "failed"
                item.error_message = str(e)
                await db.commit()

    return {"path": str(path.relative_to(root)).replace("\\", "/"), "knowledge_item_id": item_id}
