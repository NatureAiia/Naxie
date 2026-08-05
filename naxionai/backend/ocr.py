"""
NAXIONAI — OCR for image-only / scanned documents (Phase 6).

Ported from neuroworks/server/src/lib/ocr.ts, adapted to Python:
  - "local"  -> pytesseract, fully offline. Requires the Tesseract-OCR
               system binary (not pip-installable) — degrades gracefully
               with an actionable install message if it's missing, matching
               the pattern already used for optional DB drivers in
               data_source_client.py.
  - "cloud"  -> the active Phase 6 bring-your-own model provider
               (model_providers.py), sent the page as a base64 image via
               the OpenAI-compatible multimodal content array. Unavailable
               if no provider is configured.
  - "auto"   -> local first, cloud fallback only if local text is too short
               and a BYO provider is actually configured.

PDF pages are rasterized via PyMuPDF (already a naxionai dependency),
avoiding the pdfjs+canvas combination the original needed.
"""

import base64
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

MAX_BYTES_IN = 25 * 1024 * 1024
MAX_CHARS_OUT = 500_000
MIN_USEFUL_CHARS = 50
MAX_PDF_PAGES = 20

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp"}
PDF_EXTS = {".pdf"}

OcrEngine = Literal["auto", "local", "cloud"]


@dataclass
class OcrResult:
    text: str
    engine: Literal["local", "cloud"]
    bytes: int
    truncated: bool
    model: Optional[str] = None
    confidence: Optional[float] = None
    pages: Optional[int] = None


def ocr_supports_ext(ext: str) -> bool:
    e = ext.lower() if ext.startswith(".") else f".{ext.lower()}"
    return e in IMAGE_EXTS or e in PDF_EXTS


def _mime_for_ext(ext: str) -> str:
    return {
        ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp",
        ".tif": "image/tiff", ".tiff": "image/tiff", ".webp": "image/webp",
    }.get(ext, "application/octet-stream")


def _ocr_local(data: bytes, ext: str) -> OcrResult:
    try:
        import pytesseract
        from PIL import Image
    except ImportError as e:
        raise RuntimeError(
            "local OCR unavailable: pip install pytesseract pillow, and install the "
            "Tesseract-OCR binary (https://github.com/tesseract-ocr/tesseract) — "
            f"missing dependency: {e.name}"
        )

    import io

    if ext in PDF_EXTS:
        try:
            import fitz  # PyMuPDF
        except ImportError:
            raise RuntimeError("local PDF OCR unavailable: pymupdf is not installed")
        doc = fitz.open(stream=data, filetype="pdf")
        pages = min(MAX_PDF_PAGES, doc.page_count)
        parts = []
        for i in range(pages):
            pix = doc[i].get_pixmap(matrix=fitz.Matrix(2, 2))
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            parts.append(pytesseract.image_to_string(img).strip())
        doc.close()
        text = "\n\n---\n\n".join(parts).strip()
        return OcrResult(text=text[:MAX_CHARS_OUT], engine="local", bytes=len(data), pages=pages, truncated=len(text) > MAX_CHARS_OUT)

    img = Image.open(io.BytesIO(data))
    text = pytesseract.image_to_string(img).strip()
    return OcrResult(text=text[:MAX_CHARS_OUT], engine="local", bytes=len(data), truncated=len(text) > MAX_CHARS_OUT)


async def _ocr_cloud(data: bytes, ext: str) -> OcrResult:
    from model_providers import get_active_provider

    provider = get_active_provider()
    if provider is None:
        raise RuntimeError(
            "cloud OCR unavailable: no bring-your-own model provider is configured — "
            "add one under Settings > Model Providers"
        )

    import httpx

    b64 = base64.b64encode(data).decode()
    mime = _mime_for_ext(ext)
    is_pdf = ext in PDF_EXTS
    prompt_text = (
        "Extract ALL readable text from this document. Output ONLY the extracted "
        "text — no commentary, no markdown formatting, no summary. Preserve line "
        "breaks and layout where possible."
    )
    content = [
        {"type": "text", "text": prompt_text},
        {"type": "file", "file": {"filename": f"document{ext}", "file_data": f"data:{mime};base64,{b64}"}}
        if is_pdf else
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
    ]

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{provider.base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {provider.api_key}", "Content-Type": "application/json"},
            json={"model": provider.model, "messages": [{"role": "user", "content": content}], "temperature": 0.0, "max_tokens": 4096},
        )
        resp.raise_for_status()
        data_json = resp.json()
        text = (data_json.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
        return OcrResult(text=text[:MAX_CHARS_OUT], engine="cloud", model=data_json.get("model", provider.model), bytes=len(data), truncated=len(text) > MAX_CHARS_OUT)


async def ocr_file(abs_path: str, engine: OcrEngine = "auto") -> OcrResult:
    path = Path(abs_path)
    if not path.is_file():
        raise FileNotFoundError(f"ocr: not a file — {abs_path}")
    size = path.stat().st_size
    if size > MAX_BYTES_IN:
        raise ValueError(f"ocr: file too large ({size} bytes, cap {MAX_BYTES_IN})")
    ext = path.suffix.lower()
    if not ocr_supports_ext(ext):
        supported = ", ".join(sorted(IMAGE_EXTS | PDF_EXTS))
        raise ValueError(f"ocr: unsupported extension {ext} — only {supported} are handled")

    data = path.read_bytes()

    if engine == "local":
        return _ocr_local(data, ext)
    if engine == "cloud":
        return await _ocr_cloud(data, ext)

    # auto — local first, cloud fallback only if local is unavailable/poor
    # AND a BYO provider is actually configured.
    from model_providers import get_active_provider
    try:
        local = _ocr_local(data, ext)
        good_enough = len(local.text) >= MIN_USEFUL_CHARS
        if good_enough or get_active_provider() is None:
            return local
        try:
            cloud = await _ocr_cloud(data, ext)
            return cloud if len(cloud.text) > len(local.text) else local
        except Exception:
            return local
    except RuntimeError:
        if get_active_provider() is not None:
            return await _ocr_cloud(data, ext)
        raise
