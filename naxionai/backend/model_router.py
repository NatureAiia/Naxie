"""
NAXIONAI — Capability-scored model router (Phase 5)

Ported from neuroworks/server/src/lib/models.ts. Genuinely new capability
for naxionai, which today hardcodes a single Ollama model
(settings.ollama_model) per config.py. Available via api/models.py and the
functions below, but NOT wired into agent/llm.py's generate_completion —
doing that would mean threading a task-profile hint through every node
call site (the same kind of wide-touch change flagged for cost tracking in
Phase 4, except here there's no single chokepoint to centralize it at,
since the profile is inherently per-call-site context). Flagged as a
follow-up, not silently claimed as wired in.
"""

import os
import re
import time
from typing import Dict, List, Optional, TypedDict

import httpx

from config import get_settings

settings = get_settings()

KNOWN_PROFILES: Dict[str, Dict[str, float]] = {
    "qwen2.5:3b":   {"json_strict": 9, "reasoning": 6, "long_form": 8, "speed": 7, "cost": 3},
    "qwen2.5:7b":   {"json_strict": 9, "reasoning": 8, "long_form": 9, "speed": 5, "cost": 7},
    "qwen2.5:1.5b": {"json_strict": 7, "reasoning": 4, "long_form": 5, "speed": 9, "cost": 2},
    "qwen3:4b":     {"json_strict": 7, "reasoning": 9, "long_form": 6, "speed": 3, "cost": 8},
    "qwen3.5:0.8b": {"json_strict": 5, "reasoning": 3, "long_form": 4, "speed": 10, "cost": 1},
    "gemma2:2b":    {"json_strict": 6, "reasoning": 5, "long_form": 7, "speed": 8, "cost": 2},
    "gemma2:9b":    {"json_strict": 7, "reasoning": 8, "long_form": 9, "speed": 4, "cost": 9},
    "llama3.2:3b":  {"json_strict": 7, "reasoning": 6, "long_form": 7, "speed": 7, "cost": 3},
    "llama3.2:1b":  {"json_strict": 5, "reasoning": 4, "long_form": 5, "speed": 9, "cost": 1},
}
DEFAULT_PROFILE = {"json_strict": 6, "reasoning": 5, "long_form": 6, "speed": 6, "cost": 5}

# Context window (tokens) per model, keyed by name substring match. Used to
# bound how much chat history gets folded into a prompt — see
# api/chat.py's history trimming. Conservative defaults; unknown models fall
# back to DEFAULT_CONTEXT_WINDOW.
CONTEXT_WINDOWS: Dict[str, int] = {
    "qwen2.5": 32768,
    "qwen3": 32768,
    "gemma2": 8192,
    "llama3.2": 128000,
    "llama-3.3-70b-versatile": 128000,
    "mixtral-8x7b": 32768,
    "groq/compound": 128000,
}
DEFAULT_CONTEXT_WINDOW = 8192


def get_context_window(model: str) -> int:
    m = (model or "").lower()
    for key, window in CONTEXT_WINDOWS.items():
        if key.lower() in m:
            return window
    return DEFAULT_CONTEXT_WINDOW

TASK_PROFILES: Dict[str, Dict[str, float]] = {
    "planning": {"json_strict": 5, "reasoning": 3, "speed": 2},
    "synthesis": {"long_form": 5, "reasoning": 3, "speed": 2},
    "triage": {"speed": 5, "json_strict": 3, "reasoning": 1},
    "extraction": {"json_strict": 5, "reasoning": 2, "speed": 1},
    "balanced": {"json_strict": 3, "reasoning": 3, "long_form": 3, "speed": 3},
}

ENV_OVERRIDE_KEYS = {
    "planning": "OLLAMA_PLAN_MODEL",
    "synthesis": "OLLAMA_SYNTH_MODEL",
    "triage": "OLLAMA_TRIAGE_MODEL",
    "extraction": "OLLAMA_EXTRACT_MODEL",
    "balanced": "OLLAMA_BALANCED_MODEL",
}

CACHE_SECONDS = 30


class ModelInfo(TypedDict):
    name: str
    family: str
    param_size: Optional[str]
    size_gb: Optional[float]
    capabilities: Dict[str, float]


_list_cache: Optional[Dict] = None
_pick_cache: Dict[str, Dict] = {}


async def list_models() -> List[ModelInfo]:
    global _list_cache
    if _list_cache and time.monotonic() - _list_cache["at"] < CACHE_SECONDS:
        return _list_cache["models"]
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{settings.ollama_host}/api/tags")
            r.raise_for_status()
            data = r.json()
        models: List[ModelInfo] = []
        for m in data.get("models", []):
            partial = KNOWN_PROFILES.get(m["name"], {})
            models.append({
                "name": m["name"], "family": m.get("details", {}).get("family", "unknown"),
                "param_size": m.get("details", {}).get("parameter_size"),
                "size_gb": round(m.get("size", 0) / 1e8) / 10 if m.get("size") else None,
                "capabilities": {**DEFAULT_PROFILE, **partial},
            })
        _list_cache = {"at": time.monotonic(), "models": models}
        return models
    except Exception:
        # Offline or Ollama down — degrade to the configured model alone.
        return [{"name": settings.ollama_model, "family": "unknown", "param_size": None, "size_gb": None,
                 "capabilities": DEFAULT_PROFILE}]


def score_model(m: ModelInfo, needs: Dict[str, float]) -> float:
    c = m["capabilities"]
    score = 0.0
    if needs.get("json_strict"):
        score += c["json_strict"] * needs["json_strict"]
    if needs.get("reasoning"):
        score += c["reasoning"] * needs["reasoning"]
    if needs.get("long_form"):
        score += c["long_form"] * needs["long_form"]
    if needs.get("speed"):
        score += c["speed"] * needs["speed"]
    score -= c["cost"] * 0.5
    return score


async def pick_model(needs: Dict, fallback: Optional[str] = None) -> str:
    all_models = await list_models()
    candidates = all_models
    must = needs.get("must")
    exclude = needs.get("exclude")
    if must:
        candidates = [m for m in candidates if any(re.search(p, m["name"]) for p in must)]
    if exclude:
        candidates = [m for m in candidates if not any(re.search(p, m["name"]) for p in exclude)]
    if not candidates:
        return fallback or settings.ollama_model
    candidates.sort(key=lambda m: score_model(m, needs), reverse=True)
    return candidates[0]["name"]


async def pick_model_for(profile: str, fallback: Optional[str] = None) -> str:
    if profile not in TASK_PROFILES:
        raise ValueError(f"unknown profile: {profile}")
    cache_key = f"{profile}|{fallback or ''}"
    hit = _pick_cache.get(cache_key)
    if hit and time.monotonic() - hit["at"] < CACHE_SECONDS:
        return hit["name"]

    env_name = os.environ.get(ENV_OVERRIDE_KEYS[profile], "").strip()
    if env_name:
        all_models = await list_models()
        if any(m["name"] == env_name for m in all_models):
            name = env_name
        else:
            name = await pick_model(TASK_PROFILES[profile], fallback)
    else:
        name = await pick_model(TASK_PROFILES[profile], fallback)

    _pick_cache[cache_key] = {"at": time.monotonic(), "name": name}
    return name


def invalidate_model_pick_cache() -> None:
    global _list_cache
    _pick_cache.clear()
    _list_cache = None
