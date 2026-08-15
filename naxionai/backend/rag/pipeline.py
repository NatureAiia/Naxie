"""
NAXIONAI — Multimodal RAG Ingestion Pipeline
Handles: PDF, DOCX, images, video, audio, CSV, URLs, plain text.
"""

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Optional
from config import get_settings
from rag.retriever import store, ensure_collections

logger = logging.getLogger(__name__)
settings = get_settings()


# ─── Text Chunker ────────────────────────────────────────

def chunk_text(text: str, chunk_size: int = 512, overlap: int = 64) -> list[str]:
    """Semantic-ish chunking by sentence boundaries."""
    import re
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    chunks, current, current_len = [], [], 0
    for s in sentences:
        s_len = len(s)
        if current_len + s_len > chunk_size and current:
            chunks.append(" ".join(current))
            # Keep last sentence for overlap
            current = current[-1:] if overlap > 0 else []
            current_len = len(current[0]) if current else 0
        current.append(s)
        current_len += s_len
    if current:
        chunks.append(" ".join(current))
    return [c for c in chunks if len(c.strip()) > 20]


# ─── Parsers ──────────────────────────────────────────────

async def parse_pdf(file_path: str) -> str:
    """Extract text from PDF using PyMuPDF."""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(file_path)
        return "\n".join(page.get_text() for page in doc)
    except Exception as e:
        logger.error(f"PDF parse error: {e}")
        return ""


async def parse_docx(file_path: str) -> str:
    """Extract text from Word document."""
    try:
        from docx import Document
        doc = Document(file_path)
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    except Exception as e:
        logger.error(f"DOCX parse error: {e}")
        return ""


async def parse_tabular(file_path: str) -> str:
    """Convert CSV or Excel rows to natural language text."""
    try:
        import pandas as pd
        ext = Path(file_path).suffix.lower()
        if ext in [".xls", ".xlsx"]:
            df = pd.read_excel(file_path)
        else:
            df = pd.read_csv(file_path)
            
        # Convert to natural language rows
        rows = []
        for _, row in df.iterrows():
            row_text = ", ".join([f"{col}: {val}" for col, val in row.items() if str(val).strip()])
            rows.append(row_text)
        summary = f"Dataset with {len(df)} rows and columns: {', '.join(df.columns.tolist())}\n"
        return summary + "\n".join(rows[:200])  # Cap at 200 rows
    except Exception as e:
        logger.error(f"Tabular parse error: {e}")
        return ""


def _assert_public_url(url: str) -> None:
    """Block server-side fetches of loopback/private/link-local targets (SSRF guard)."""
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Disallowed URL scheme: {parsed.scheme}")
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid URL: no host")
    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except socket.gaierror:
        raise ValueError(f"Could not resolve host: {host}")
    for addr in addrs:
        ip = ipaddress.ip_address(addr)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ValueError(f"URL resolves to a disallowed address: {addr}")


async def parse_url(url: str) -> str:
    """Scrape and clean text from a URL. Validates every hop (including redirects) against
    loopback/private/link-local targets to prevent SSRF."""
    try:
        import httpx
        from bs4 import BeautifulSoup

        _assert_public_url(url)
        current = url
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            for _ in range(5):  # manual redirect cap, re-validating each hop
                resp = await client.get(current, headers={"User-Agent": "Mozilla/5.0"})
                if resp.is_redirect:
                    next_url = str(resp.next_request.url) if resp.next_request else resp.headers.get("location")
                    if not next_url:
                        break
                    _assert_public_url(next_url)
                    current = next_url
                    continue
                resp.raise_for_status()
                soup = BeautifulSoup(resp.text, "lxml")
                # Remove noise
                for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
                    tag.decompose()
                return soup.get_text(separator="\n", strip=True)[:50000]
        return ""
    except Exception as e:
        logger.error(f"URL parse error ({url}): {e}")
        return ""


async def parse_image(file_path: str) -> str:
    """Generate text description of an image using Groq Vision."""
    key = settings.groq_api_key_1 or settings.groq_api_key_2 or settings.groq_api_key_3
    if not key:
        return f"Image asset: {Path(file_path).name}"
    try:
        import base64
        from groq import AsyncGroq
        client = AsyncGroq(api_key=key)
        with open(file_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        ext = Path(file_path).suffix.lstrip(".").lower()
        media_type = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "webp": "webp"}.get(ext, "jpeg")
        resp = await client.chat.completions.create(
            model="llama-3.2-90b-vision-preview",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this image in detail for a social media context. Include: visual elements, text visible, colors, mood, and how it could be used for marketing."},
                    {"type": "image_url", "image_url": {"url": f"data:image/{media_type};base64,{b64}"}}
                ]
            }],
            max_tokens=500,
        )
        return resp.choices[0].message.content
    except Exception as e:
        logger.error(f"Image parse error: {e}")
        return f"Image: {Path(file_path).name}"


_whisper_model = None


def _get_whisper_model():
    """Load the faster-whisper model once and cache it — loading is seconds of
    CPU/GPU work and MUST NOT run on every transcription. Uses the same
    faster-whisper backend as the live voice/STT endpoint (api/voice.py) —
    openai-whisper is not installed, so importing it here silently produced
    empty transcriptions."""
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(settings.whisper_model_size, device="cpu", compute_type="int8")
    return _whisper_model


def _transcribe(file_path: str) -> str:
    model = _get_whisper_model()
    segments, _info = model.transcribe(file_path, beam_size=1)
    return "".join(segment.text for segment in segments).strip()


async def parse_audio_video(file_path: str) -> str:
    """Transcribe audio/video using local faster-whisper. Both the (cached)
    model load and the transcription are blocking CPU work — offload them so
    they don't freeze the event loop and every concurrent request."""
    try:
        return await asyncio.to_thread(_transcribe, file_path)
    except Exception as e:
        logger.error(f"Audio/video transcription error: {e}")
        return ""


# ─── Main Pipeline ────────────────────────────────────────

async def ingest(
    source_type: str,
    source_path: str,
    knowledge_item_id: str,
    title: str = "",
    category: str = "other",
    tags: list[str] = None,
) -> dict:
    """
    Main ingestion pipeline. Parses → chunks → embeds → stores in Qdrant.
    Returns: {success, chunk_count, qdrant_ids}
    """
    await ensure_collections()

    # Step 1: Parse
    logger.info(f"[RAG] Ingesting {source_type}: {source_path}")
    raw_text = ""

    type_lower = source_type.lower()
    if type_lower == "pdf":
        raw_text = await parse_pdf(source_path)
    elif type_lower in ("docx", "doc"):
        raw_text = await parse_docx(source_path)
    elif type_lower in ("csv", "xlsx", "xls"):
        raw_text = await parse_tabular(source_path)
    elif type_lower == "url":
        raw_text = await parse_url(source_path)
    elif type_lower in ("image", "png", "jpg", "jpeg", "webp"):
        raw_text = await parse_image(source_path)
    elif type_lower in ("video", "audio", "mp4", "mov", "mp3", "wav"):
        raw_text = await parse_audio_video(source_path)
    elif type_lower == "text":
        try:
            raw_text = Path(source_path).read_text(encoding="utf-8")
        except Exception:
            raw_text = source_path  # Treat as raw text if not a path
    else:
        return {"success": False, "error": f"Unsupported source type: {source_type}"}

    if not raw_text or len(raw_text.strip()) < 10:
        return {"success": False, "error": "No extractable content found"}

    # Step 2: Chunk
    chunks = chunk_text(raw_text)
    logger.info(f"[RAG] {len(chunks)} chunks from {source_type}")

    # Determine collection
    collection = "brand" if category == "brand_voice" else "knowledge"

    # Step 3: Embed + Store
    qdrant_ids = []
    for i, chunk in enumerate(chunks):
        metadata = {
            "knowledge_item_id": knowledge_item_id,
            "title": title,
            "source_type": source_type,
            "category": category,
            "tags": tags or [],
            "chunk_index": i,
            "total_chunks": len(chunks),
        }
        try:
            pid = await store(chunk, metadata, collection=collection)
            qdrant_ids.append(pid)
        except Exception as e:
            logger.error(f"[RAG] Store failed for chunk {i}: {e}")

    return {
        "success": True,
        "chunk_count": len(chunks),
        "qdrant_ids": qdrant_ids,
        "raw_text_preview": raw_text[:500],
    }
