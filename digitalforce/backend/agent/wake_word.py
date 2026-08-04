"""
NaxionAI — Offline Wake-Word Detection (Vosk)

Fully local, free, open-source speech recognition (no cloud API, no API key,
no per-request cost) used purely to detect the wake phrase from a live mic
audio stream. This replaces the browser's SpeechRecognition API, which in
Chrome/Edge streams audio to a vendor's cloud recognition service just to
detect the wake phrase, and isn't available at all in Firefox.

The actual command spoken after the wake word fires still goes through
faster-whisper (api/voice.py) for full transcription — Vosk here only needs
to recognize a short phrase, so a small (~40MB) model is enough.
"""

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_VOSK_MODEL_DIR = Path(__file__).resolve().parent.parent / "media" / "vosk_model"
_model = None
_model_load_attempted = False


def get_vosk_model():
    """Lazily load the Vosk model once and cache it. Returns None (not raises)
    if the vosk package or model files aren't available, so callers can
    degrade gracefully."""
    global _model, _model_load_attempted
    if _model_load_attempted:
        return _model
    _model_load_attempted = True

    if not _VOSK_MODEL_DIR.exists():
        logger.warning(
            f"[WakeWord] Vosk model not found at {_VOSK_MODEL_DIR} — offline "
            "wake-word detection disabled. Download a small model (e.g. "
            "vosk-model-small-en-us-0.15) from https://alphacephei.com/vosk/models "
            "and extract its contents directly into that folder."
        )
        return None
    try:
        import vosk
        vosk.SetLogLevel(-1)  # Vosk logs to stdout by default; keep it quiet.
        _model = vosk.Model(str(_VOSK_MODEL_DIR))
        logger.info("[WakeWord] Vosk model loaded.")
    except Exception as e:
        logger.error(f"[WakeWord] Failed to load Vosk model: {e}")
        _model = None
    return _model


# vosk-model-small-en-us-0.15 has a fixed dictionary from general English
# text — invented brand names like "Naxie" simply aren't in it, so a bare
# KaldiRecognizer mishears "Hey Naxie" as something unrelated (e.g. "hey
# see"). Grammar-constrained decoding (biasing the decoder toward a small
# candidate list instead of open dictation) fixes this, but the model still
# needs an in-vocabulary word to match the sound against — these were picked
# by testing which near-homophones of "naxie" the model's dictionary actually
# contains.
_PHONETIC_VARIANTS = {
    "naxie": ["nexi", "naxi", "nyx", "nixie", "natty", "nexus", "annex"],
}


def _build_grammar(phrase: str) -> list:
    """Expand a wake phrase into itself plus in-vocabulary phonetic near-misses
    for any word we have known variants for (currently just "naxie" — other,
    real-English wake phrases need no expansion since Vosk already knows them)."""
    words = phrase.strip().lower().split()
    variants = {phrase.strip().lower()}
    for i, w in enumerate(words):
        for v in _PHONETIC_VARIANTS.get(w, []):
            alt = words.copy()
            alt[i] = v
            variants.add(" ".join(alt))
    return sorted(variants)


class WakeWordSession:
    """One instance per connected WebSocket client. Feeds 16kHz mono PCM16
    audio into a Vosk streaming recognizer, constrained to a small grammar of
    the wake phrase and its known phonetic variants, and reports whether any
    of them matched (partial or final result)."""

    def __init__(self, phrase: str, sample_rate: int = 16000):
        import vosk
        model = get_vosk_model()
        if model is None:
            raise RuntimeError("Vosk model unavailable — see server logs for download instructions.")
        self._targets = set(_build_grammar(phrase or "hey naxie"))
        grammar = json.dumps(sorted(self._targets) + ["[unk]"])
        self._rec = vosk.KaldiRecognizer(model, sample_rate, grammar)

    def accept(self, pcm_bytes: bytes) -> bool:
        """Feed one chunk of raw 16-bit PCM audio. Returns True the moment any
        wake-phrase variant is detected in the live transcript."""
        is_final = self._rec.AcceptWaveform(pcm_bytes)
        if is_final:
            result = json.loads(self._rec.Result())
            text = (result.get("text") or "").lower()
        else:
            partial = json.loads(self._rec.PartialResult())
            text = (partial.get("partial") or "").lower()
        if text and text in self._targets:
            self._rec.Reset()
            return True
        return False
