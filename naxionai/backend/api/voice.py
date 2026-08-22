"""
NAXIONAI — Voice API
Local speech-to-text (faster-whisper) and local text-to-speech (Piper if a
voice model is installed on disk, falling back to the OS-provided pyttsx3
voices otherwise — no cloud API key required for either direction).
"""

import hashlib
import io
import logging
import os
import tempfile
import wave
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel

from auth import get_current_user
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api/voice", tags=["voice"])

MAX_TTS_CHARS = 2000

_PIPER_VOICES_DIR = Path(__file__).resolve().parent.parent / "media" / "tts_voices"
_TTS_CACHE_DIR = Path(__file__).resolve().parent.parent / "media" / "tts_cache"
_TTS_CACHE_EXT_BY_MEDIA_TYPE = {"audio/mpeg": "mp3", "audio/wav": "wav"}


def _tts_cache_key(text: str, voice: str, engine: str) -> str:
    """Content-addressed cache key so repeated speak() calls for the same
    text+voice+engine (e.g. recurring status phrases, idle-report boilerplate)
    skip synthesis entirely instead of re-paying for it every time."""
    raw = f"{text}|{voice}|{engine}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _tts_cache_load(key: str) -> Optional[tuple[bytes, str]]:
    for media_type, ext in _TTS_CACHE_EXT_BY_MEDIA_TYPE.items():
        path = _TTS_CACHE_DIR / f"{key}.{ext}"
        if path.exists():
            try:
                return path.read_bytes(), media_type
            except OSError:
                return None
    return None


def _tts_cache_store(key: str, audio_bytes: bytes, media_type: str) -> None:
    ext = _TTS_CACHE_EXT_BY_MEDIA_TYPE.get(media_type)
    if ext is None:
        return
    try:
        _TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (_TTS_CACHE_DIR / f"{key}.{ext}").write_bytes(audio_bytes)
    except OSError as e:
        logger.warning(f"[Voice] Failed to write TTS cache entry: {e}")

# --- STT: faster-whisper, loaded once as a module-level singleton (model load
# takes several seconds — must not happen per-request). ---
_whisper_model = None


def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        logger.info(f"[Voice] Loading faster-whisper model '{settings.whisper_model_size}' (CPU, int8)...")
        _whisper_model = WhisperModel(settings.whisper_model_size, device="cpu", compute_type="int8")
    return _whisper_model


class SpeakBody(BaseModel):
    text: str
    voice: Optional[str] = None


@router.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Transcribe an uploaded audio clip (mic recording) to text using local Whisper."""
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload")

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        model = _get_whisper_model()
        segments, _info = model.transcribe(tmp_path, beam_size=1)
        text = "".join(segment.text for segment in segments).strip()
        return {"text": text}
    except Exception as e:
        logger.error(f"[Voice] Transcription failed: {e}")
        raise HTTPException(status_code=502, detail=f"Transcription failed: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@router.websocket("/ws/wake")
async def wake_word_ws(websocket: WebSocket):
    """
    Offline wake-word detection (Vosk — free, local, no cloud API).
    Client streams raw 16kHz mono 16-bit PCM audio as binary WebSocket frames;
    the wake phrase (query param `phrase`, default "hey naxie") is matched
    against the live Vosk transcript. Sends {"type": "wake"} the moment it's
    detected. No auth — this app runs single-user/local by design.
    """
    phrase = websocket.query_params.get("phrase", "hey naxie")
    await websocket.accept()

    from agent.wake_word import WakeWordSession
    try:
        session = WakeWordSession(phrase)
    except Exception as e:
        await websocket.send_json({"type": "error", "message": str(e)})
        await websocket.close()
        return

    try:
        while True:
            data = await websocket.receive_bytes()
            if session.accept(data):
                await websocket.send_json({"type": "wake"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"[WakeWord] WebSocket session ended: {e}")


# --- TTS: ElevenLabs (Rachel voice ID) -> Piper -> pyttsx3 fallback ---
_piper_voice = None
_piper_load_attempted = False


def _synthesize_elevenlabs(text: str, voice_id: Optional[str] = None) -> tuple[bytes, str]:
    import urllib.request
    import json

    vid = voice_id or getattr(settings, "elevenlabs_voice_id", "EXAVITQu4vr4xnSDxMaL")
    api_key = getattr(settings, "elevenlabs_api_key", os.getenv("ELEVENLABS_API_KEY", ""))

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{vid}"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["xi-api-key"] = api_key

    data = json.dumps({
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75
        }
    }).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        audio = resp.read()
        media_type = resp.headers.get("Content-Type", "audio/mpeg")
        return audio, media_type


def _get_piper_voice():
    """Lazily load a Piper voice model from disk. Returns None if unavailable
    (missing package or missing .onnx model file) so callers fall back to pyttsx3."""
    global _piper_voice, _piper_load_attempted
    if _piper_load_attempted:
        return _piper_voice
    _piper_load_attempted = True

    model_path = _PIPER_VOICES_DIR / f"{settings.piper_voice}.onnx"
    if not model_path.exists():
        logger.info(
            f"[Voice] Piper voice model not found at {model_path} — falling back to pyttsx3. "
            f"For better quality TTS, download a Piper voice (e.g. from "
            f"https://huggingface.co/rhasspy/piper-voices) into {_PIPER_VOICES_DIR} as "
            f"'{settings.piper_voice}.onnx' (+ matching '.onnx.json' config)."
        )
        return None

    try:
        from piper import PiperVoice
        _piper_voice = PiperVoice.load(str(model_path))
        logger.info(f"[Voice] Loaded Piper voice '{settings.piper_voice}'.")
    except Exception as e:
        logger.warning(f"[Voice] Failed to load Piper voice, falling back to pyttsx3: {e}")
        _piper_voice = None

    return _piper_voice


def _synthesize_piper(text: str) -> bytes:
    voice = _get_piper_voice()
    if voice is None:
        raise RuntimeError("Piper voice unavailable")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        voice.synthesize_wav(text, wav_file)
    return buf.getvalue()


def _synthesize_pyttsx3(text: str) -> bytes:
    import pyttsx3
    engine = pyttsx3.init()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        engine.save_to_file(text, tmp_path)
        engine.runAndWait()
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def synthesize_speech_bytes(text: str, voice: Optional[str] = None) -> tuple[bytes, str]:
    """ElevenLabs -> Piper -> pyttsx3 cascade, cached by (text, voice, engine).
    Shared by the /speak endpoint and any background caller (e.g. the morning
    digest) that needs rendered audio without going through HTTP."""
    text = text.strip()[:MAX_TTS_CHARS]
    cache_voice = voice or getattr(settings, "elevenlabs_voice_id", "EXAVITQu4vr4xnSDxMaL")
    cache_key = _tts_cache_key(text, cache_voice, settings.tts_engine)
    cached = _tts_cache_load(cache_key)
    if cached is not None:
        return cached

    audio_bytes = None
    media_type = "audio/wav"

    if settings.tts_engine == "elevenlabs" or (voice and voice.startswith("c3Q")):
        try:
            target_voice = voice or getattr(settings, "elevenlabs_voice_id", "EXAVITQu4vr4xnSDxMaL")
            audio_bytes, media_type = _synthesize_elevenlabs(text, voice_id=target_voice)
            logger.info(f"[Voice] Synthesized speech via ElevenLabs (Voice ID: {target_voice}).")
        except Exception as e:
            logger.warning(f"[Voice] ElevenLabs synthesis failed: {e}. Falling back to local TTS engine...")

    if audio_bytes is None and settings.tts_engine in ("piper", "elevenlabs"):
        try:
            audio_bytes = _synthesize_piper(text)
            media_type = "audio/wav"
        except Exception as e:
            logger.warning(f"[Voice] Piper synthesis failed, falling back to pyttsx3: {e}")

    if audio_bytes is None:
        audio_bytes = _synthesize_pyttsx3(text)
        media_type = "audio/wav"

    _tts_cache_store(cache_key, audio_bytes, media_type)
    return audio_bytes, media_type


@router.post("/speak")
async def speak_text(
    body: SpeakBody,
    user: dict = Depends(get_current_user),
):
    """Synthesize speech for the given text using ElevenLabs (Rachel voice),
    Piper local TTS, or the OS-provided pyttsx3 voices."""
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")

    try:
        audio_bytes, media_type = synthesize_speech_bytes(text, voice=body.voice)
        return Response(content=audio_bytes, media_type=media_type)
    except Exception as e:
        logger.error(f"[Voice] Speech synthesis failed: {e}")
        raise HTTPException(status_code=502, detail=f"Speech synthesis failed: {e}")

