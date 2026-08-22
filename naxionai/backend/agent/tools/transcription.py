"""
NAXIONAI — Standalone Audio/Video Transcription Tool
Transcribes any audio or video file to text using local Whisper. Auto-picks
its own model size from the clip's duration: short clips get a bigger, more
accurate model since the extra compute is cheap either way; long clips drop
to a smaller model so total runtime stays bounded on this CPU-only machine
(no CUDA available).

Two interchangeable engines:
  - "faster" (faster-whisper, default) — no system ffmpeg binary required
    (decodes via the bundled PyAV library), faster on CPU. Same engine
    already used by api/voice.py and rag/pipeline.py.
  - "openai" (openai-whisper) — needs a real `ffmpeg` binary on PATH to
    decode audio/video; raises a clear error up front if it's missing
    instead of silently returning an empty transcript.

CLI usage:
    python transcription.py path/to/file.mp4
    python transcription.py path/to/file.mp3 --engine openai --model medium
    python transcription.py path/to/file.wav --json

Library usage (e.g. from an agent tool or another script):
    from agent.tools.transcription import transcribe
    result = transcribe("meeting.mp4")
    print(result["text"])
"""

import argparse
import logging
import shutil
import sys
from pathlib import Path
from typing import Literal, Optional

logger = logging.getLogger(__name__)

# (max_duration_seconds, model_size) — first tier whose ceiling covers the
# clip's duration wins. Short clips can afford a heavier model because the
# absolute compute cost is tiny either way; long clips need a lighter model
# or a CPU-only box never finishes in reasonable time.
_DURATION_MODEL_TIERS: list[tuple[float, str]] = [
    (30, "medium"),
    (180, "small"),
    (3600, "base"),
    (float("inf"), "tiny"),
]

_DEFAULT_MODEL_SIZE = "base"  # used when duration can't be probed at all

_faster_whisper_models: dict[str, object] = {}
_openai_whisper_models: dict[str, object] = {}


def _probe_duration_seconds(path: str) -> Optional[float]:
    """Read container duration without decoding audio, so picking a model
    size doesn't require loading one first. Tries PyAV (already a
    faster-whisper dependency) then falls back to ffprobe."""
    try:
        import av
        with av.open(path) as container:
            if container.duration:
                return container.duration / 1_000_000
    except Exception as e:
        logger.debug(f"[Transcribe] PyAV duration probe failed: {e}")

    try:
        import subprocess
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except Exception as e:
        logger.debug(f"[Transcribe] ffprobe duration probe failed: {e}")
        return None


def pick_model_size(duration_seconds: Optional[float]) -> str:
    """Auto-scale model size by clip length. Falls back to a middling
    default if duration couldn't be determined."""
    if duration_seconds is None:
        return _DEFAULT_MODEL_SIZE
    for ceiling, size in _DURATION_MODEL_TIERS:
        if duration_seconds <= ceiling:
            return size
    return _DURATION_MODEL_TIERS[-1][1]


def _get_faster_whisper_model(size: str):
    if size not in _faster_whisper_models:
        from faster_whisper import WhisperModel
        logger.info(f"[Transcribe] Loading faster-whisper model '{size}' (CPU, int8)...")
        _faster_whisper_models[size] = WhisperModel(size, device="cpu", compute_type="int8")
    return _faster_whisper_models[size]


def _get_openai_whisper_model(size: str):
    if size not in _openai_whisper_models:
        import whisper
        logger.info(f"[Transcribe] Loading openai-whisper model '{size}'...")
        _openai_whisper_models[size] = whisper.load_model(size)
    return _openai_whisper_models[size]


def _transcribe_faster(path: str, size: str, language: Optional[str], task: str) -> dict:
    model = _get_faster_whisper_model(size)
    segments, info = model.transcribe(path, beam_size=1, language=language, task=task)
    segments = list(segments)
    return {
        "text": "".join(s.text for s in segments).strip(),
        "segments": [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments],
        "language": info.language,
    }


def _transcribe_openai(path: str, size: str, language: Optional[str], task: str) -> dict:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "openai-whisper needs a real 'ffmpeg' binary on PATH to decode audio/video "
            "(faster-whisper doesn't need this — it bundles its own decoder). Install "
            "ffmpeg (e.g. `winget install Gyan.FFmpeg`), reopen your terminal, or pass "
            "engine='faster' instead."
        )
    model = _get_openai_whisper_model(size)
    result = model.transcribe(path, language=language, task=task)
    return {
        "text": result["text"].strip(),
        "segments": [
            {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
            for s in result["segments"]
        ],
        "language": result.get("language"),
    }


def transcribe(
    file_path: str,
    engine: Literal["auto", "faster", "openai"] = "auto",
    model_size: Optional[str] = None,
    language: Optional[str] = None,
    task: Literal["transcribe", "translate"] = "transcribe",
) -> dict:
    """Transcribe any audio or video file. Auto-picks a model size from clip
    duration unless model_size is given explicitly.

    Returns {text, segments, language, engine, model, duration_seconds}.
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"No such file: {file_path}")

    duration = _probe_duration_seconds(str(path))
    size = model_size or pick_model_size(duration)

    if engine == "auto":
        try:
            import faster_whisper  # noqa: F401
            engine = "faster"
        except ImportError:
            engine = "openai"

    logger.info(f"[Transcribe] {path.name}: duration={duration}, engine={engine}, model={size}")

    if engine == "faster":
        result = _transcribe_faster(str(path), size, language, task)
    elif engine == "openai":
        result = _transcribe_openai(str(path), size, language, task)
    else:
        raise ValueError(f"Unknown engine '{engine}' — expected 'auto', 'faster', or 'openai'.")

    result["engine"] = engine
    result["model"] = size
    result["duration_seconds"] = duration
    return result


def _main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe an audio or video file with local Whisper.")
    parser.add_argument("file", help="Path to the audio or video file.")
    parser.add_argument("--engine", choices=["auto", "faster", "openai"], default="auto")
    parser.add_argument("--model", default=None,
                         help="Override the auto-picked model size (tiny/base/small/medium/large-v3/...).")
    parser.add_argument("--language", default=None, help="Force a source language (e.g. 'en'). Default: auto-detect.")
    parser.add_argument("--task", choices=["transcribe", "translate"], default="transcribe")
    parser.add_argument("--json", action="store_true",
                         help="Print the full result (with segment timestamps) as JSON instead of plain text.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    try:
        result = transcribe(
            args.file, engine=args.engine, model_size=args.model,
            language=args.language, task=args.task,
        )
    except Exception as e:
        print(f"Transcription failed: {e}", file=sys.stderr)
        return 1

    if args.json:
        import json
        print(json.dumps(result, indent=2))
    else:
        print(result["text"])
    return 0


if __name__ == "__main__":
    sys.exit(_main())
