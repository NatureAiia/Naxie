"""
NAXIONAI — Bring-your-own LLM providers (Phase 6).

Ported from neuroworks/server/src/lib/model-providers.ts. Lets the operator
plug in a model API they already have a key for (OpenAI, Anthropic,
OpenRouter, Groq, Together, or any OpenAI-compatible endpoint) without
editing .env. Everything routes through the OpenAI-compatible chat-
completions schema — the lingua franca all of these speak (Anthropic via
its own /v1/chat/completions-compatible endpoint included) — so one HTTP
client path in agent/llm.py covers every kind.

Persisted (key encrypted via encryption.py) in the model_provider_configs
table so the active choice survives a restart; see load_and_apply_active_provider().
Scope trimmed from the original: no per-kind small/large model cost-tiering
(that logic was tuned to neuroworks's own OpenRouter/Anthropic billing
setup) and no fallback-chain — naxionai already has its own fallback
(Ollama <-> Groq cascade in llm.py); a BYO provider is an additional,
explicitly-opted-into option, not a third leg of that cascade.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import ModelProviderConfig, async_session
from encryption import decrypt_value, encrypt_value

PROVIDER_DEFAULTS: dict[str, dict[str, str]] = {
    # Anthropic via its OpenAI-compatible endpoint so it flows through the
    # same Bearer-auth/streaming client as every other provider.
    "anthropic": {"label": "Anthropic (Claude)", "base_url": "https://api.anthropic.com/v1", "model_hint": "claude-fable-5"},
    "openai": {"label": "OpenAI", "base_url": "https://api.openai.com/v1", "model_hint": "gpt-4o-mini"},
    "openrouter": {"label": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "model_hint": "openai/gpt-4o-mini"},
    "groq": {"label": "Groq", "base_url": "https://api.groq.com/openai/v1", "model_hint": "llama-3.3-70b-versatile"},
    "together": {"label": "Together", "base_url": "https://api.together.xyz/v1", "model_hint": "meta-llama/Llama-3.3-70B-Instruct-Turbo"},
    "custom": {"label": "Custom (OpenAI-compatible)", "base_url": "", "model_hint": ""},
}


@dataclass
class ProviderRuntime:
    id: str
    kind: str
    label: str
    base_url: str
    model: str
    api_key: str  # decrypted, in-memory only


def _public(row: ModelProviderConfig) -> dict:
    key = decrypt_value(row.api_key_encrypted) if row.api_key_encrypted else ""
    return {
        "id": row.id, "label": row.label, "kind": row.kind, "base_url": row.base_url,
        "model": row.model, "active": row.active, "created_at": row.created_at.isoformat(),
        "key_prefix": (key[:6] + "…") if key else "",
    }


async def list_providers(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(select(ModelProviderConfig).order_by(ModelProviderConfig.created_at.desc()))).scalars().all()
    return [_public(r) for r in rows]


async def add_provider(
    db: AsyncSession, *, kind: str, model: str, api_key: str,
    label: Optional[str] = None, base_url: Optional[str] = None, active: bool = True,
) -> dict:
    if kind not in PROVIDER_DEFAULTS:
        raise ValueError(f"unknown provider kind: {kind}")
    defaults = PROVIDER_DEFAULTS[kind]
    resolved_base_url = (base_url or "").strip() or defaults["base_url"]
    if not resolved_base_url:
        raise ValueError("base_url is required for a custom provider")
    if not model.strip():
        raise ValueError("model is required")
    if not api_key.strip():
        raise ValueError("api_key is required")

    if active:
        for other in (await db.execute(select(ModelProviderConfig))).scalars().all():
            other.active = False

    row = ModelProviderConfig(
        id=str(uuid.uuid4()), label=(label or defaults["label"]).strip() or defaults["label"],
        kind=kind, base_url=resolved_base_url, model=model.strip(),
        api_key_encrypted=encrypt_value(api_key.strip()), active=active,
    )
    db.add(row)
    await db.commit()
    if active:
        _apply_to_runtime(row)
    return _public(row)


async def remove_provider(db: AsyncSession, provider_id: str) -> bool:
    row = (await db.execute(select(ModelProviderConfig).where(ModelProviderConfig.id == provider_id))).scalars().first()
    if not row:
        return False
    was_active = row.active
    await db.delete(row)
    await db.commit()
    if was_active:
        _apply_to_runtime(None)
    return True


async def activate_provider(db: AsyncSession, provider_id: str) -> Optional[dict]:
    rows = (await db.execute(select(ModelProviderConfig))).scalars().all()
    target = next((r for r in rows if r.id == provider_id), None)
    if not target:
        return None
    for r in rows:
        r.active = r.id == provider_id
    await db.commit()
    _apply_to_runtime(target)
    return _public(target)


# ── Runtime application ─────────────────────────────────────────────────
# agent/llm.py checks get_active_provider() at call time and, when set,
# routes through it instead of the Ollama/Groq cascade. This is a module-
# level override (not a mutation of the cached Settings singleton) so it's
# explicit and easy to reason about.

_active: Optional[ProviderRuntime] = None


def get_active_provider() -> Optional[ProviderRuntime]:
    return _active


def _apply_to_runtime(row: Optional[ModelProviderConfig]) -> None:
    global _active
    if row is None:
        _active = None
        return
    _active = ProviderRuntime(
        id=row.id, kind=row.kind, label=row.label, base_url=row.base_url,
        model=row.model, api_key=decrypt_value(row.api_key_encrypted),
    )


async def load_and_apply_active_provider() -> None:
    """Called once at boot: re-apply whichever provider was marked active so
    a UI-added key survives restarts."""
    async with async_session() as db:
        row = (await db.execute(select(ModelProviderConfig).where(ModelProviderConfig.active == True))).scalars().first()  # noqa: E712
        if row:
            _apply_to_runtime(row)
