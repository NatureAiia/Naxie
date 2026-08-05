"""
NAXIONAI — LLM cost tracking (Phase 4, net-new instrumentation)

Ported from neuroworks/server/src/lib/cost-tracker.ts. naxionai had zero
cost tracking before this. Wired centrally into agent/llm.py's
generate_completion() — the single chokepoint both generate_json() and
most agent nodes already call through — rather than touching every node's
call site individually. Token counts are estimated from text length ÷ 4
(same heuristic as the TS original); neither Ollama nor the Groq/LangChain
path used here surfaces real provider-billed usage.
"""

import logging
import re
import uuid
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

# Approximate cost per 1K tokens (USD) per backend/model tier. Ollama local
# is free but tracked at $0 to distinguish from paid.
COST_PER_1K_INPUT = {
    "ollama": 0.0,
    "openrouter/small": 0.00015,
    "openrouter/medium": 0.003,
    "openrouter/large": 0.015,
    "anthropic/fable": 0.010,
    "anthropic/opus": 0.005,
    "anthropic/sonnet": 0.003,
    "anthropic/haiku": 0.001,
    "openai/flagship": 0.00125,
    "openai/mini": 0.00025,
    "gemini/flash": 0.0003,
    "groq": 0.0,  # naxionai's Groq cascade is on a free/dev tier — see note below
}
COST_PER_1K_OUTPUT = {
    "ollama": 0.0,
    "openrouter/small": 0.0006,
    "openrouter/medium": 0.015,
    "openrouter/large": 0.075,
    "anthropic/fable": 0.050,
    "anthropic/opus": 0.025,
    "anthropic/sonnet": 0.015,
    "anthropic/haiku": 0.005,
    "openai/flagship": 0.010,
    "openai/mini": 0.002,
    "gemini/flash": 0.0025,
    "groq": 0.0,
}


def detect_backend(model: str) -> str:
    lc = (model or "").lower()
    if lc.startswith("claude-"):
        return "anthropic"
    if "/" in lc:
        return "openrouter"
    if re.match(r"^(gpt-\d|o\d[-\d]|chatgpt|text-embedding|dall-e)", lc):
        return "openrouter"
    # naxionai-specific: the Groq cascade models (llama-3.3-70b-versatile,
    # mixtral-8x7b-32768, groq/compound) have no slash and aren't Claude/GPT
    # ids — classify explicitly rather than falling through to "ollama"
    # (which would misreport real Groq API usage as free local inference).
    if re.match(r"^(llama-|mixtral-|groq/)", lc):
        return "groq"
    return "ollama"


def cost_tier(model: str) -> str:
    m = model or ""
    if re.match(r"^claude-fable|^claude-mythos", m, re.IGNORECASE):
        return "anthropic/fable"
    if re.match(r"^claude-opus", m, re.IGNORECASE):
        return "anthropic/opus"
    if re.match(r"^claude-sonnet", m, re.IGNORECASE):
        return "anthropic/sonnet"
    if re.match(r"^claude-haiku", m, re.IGNORECASE):
        return "anthropic/haiku"
    if re.match(r"^gpt-\d[\d.]*-?(mini|nano)", m, re.IGNORECASE):
        return "openai/mini"
    if re.match(r"^gpt-\d", m, re.IGNORECASE):
        return "openai/flagship"
    if re.search(r"gemini.*flash", m, re.IGNORECASE):
        return "gemini/flash"
    if re.search(r"opus|gpt-4\.5|gpt-4-?turbo|claude-3-5-sonnet|claude-opus", m, re.IGNORECASE):
        return "openrouter/large"
    if re.search(r"gpt-4o(?!-mini)|claude-sonnet|claude-3-haiku|llama-3-70b|mixtral", m, re.IGNORECASE):
        return "openrouter/medium"
    return "openrouter/small"


def estimate_tokens(text: str) -> int:
    """Heuristic fallback when a provider doesn't report real usage: ~4 chars/token."""
    return len(text or "") // 4


def estimate_cost(model: str, backend: str, input_tokens: int, output_tokens: int) -> float:
    if backend in ("ollama", "groq"):
        return 0.0
    if re.search(r":free\b", model or "", re.IGNORECASE):
        return 0.0
    tier = cost_tier(model)
    in_rate = COST_PER_1K_INPUT.get(tier, COST_PER_1K_INPUT["openrouter/small"])
    out_rate = COST_PER_1K_OUTPUT.get(tier, COST_PER_1K_OUTPUT["openrouter/small"])
    return (input_tokens / 1000) * in_rate + (output_tokens / 1000) * out_rate


async def record_llm_cost(
    model: str,
    output_text: str,
    input_text: str,
    system_text: str = "",
    profile: str = "none",
    job_id: str = "adhoc",
    usage: Optional[dict] = None,
    domain: str = "general",
) -> None:
    """Best-effort — never let cost tracking break a real LLM call.
    `usage` is the provider's real usage_metadata ({"input_tokens", "output_tokens", ...})
    when the caller has it; falls back to a text-length estimate otherwise."""
    try:
        from database import async_session, CostRecord

        if usage:
            input_tokens = int(usage.get("input_tokens") or 0)
            output_tokens = int(usage.get("output_tokens") or 0)
        else:
            input_tokens = estimate_tokens(input_text) + estimate_tokens(system_text)
            output_tokens = estimate_tokens(output_text)
        backend = detect_backend(model)
        cost_usd = estimate_cost(model, backend, input_tokens, output_tokens)
        async with async_session() as db:
            db.add(CostRecord(
                id=str(uuid.uuid4()), job_id=job_id or "adhoc", model=model, backend=backend,
                profile=profile, input_tokens=input_tokens, output_tokens=output_tokens, cost_usd=cost_usd,
                domain=domain or "general",
            ))
            await db.commit()
    except Exception as e:
        logger.warning(f"[CostTracker] record failed: {e}")


async def get_cost_summary(
    owner_id: Optional[str] = None,
    since_days: Optional[int] = None,
    domain: Optional[str] = None,
) -> dict:
    from sqlalchemy import select
    from database import async_session, CostRecord

    async with async_session() as db:
        stmt = select(CostRecord)
        if since_days is not None:
            stmt = stmt.where(CostRecord.created_at >= datetime.utcnow() - timedelta(days=since_days))
        if domain:
            stmt = stmt.where(CostRecord.domain == domain)
        rows = (await db.execute(stmt.order_by(CostRecord.created_at.desc()))).scalars().all()

    total_cost = sum(r.cost_usd for r in rows)
    total_in = sum(r.input_tokens for r in rows)
    total_out = sum(r.output_tokens for r in rows)
    by_model: dict = {}
    by_day: dict = {}
    by_domain: dict = {}
    for r in rows:
        m = by_model.setdefault(r.model, {"cost_usd": 0.0, "calls": 0})
        m["cost_usd"] += r.cost_usd
        m["calls"] += 1
        day = r.created_at.strftime("%Y-%m-%d")
        d = by_day.setdefault(day, {"cost_usd": 0.0, "calls": 0})
        d["cost_usd"] += r.cost_usd
        d["calls"] += 1
        dom = by_domain.setdefault(r.domain or "general", {"cost_usd": 0.0, "calls": 0, "input_tokens": 0, "output_tokens": 0})
        dom["cost_usd"] += r.cost_usd
        dom["calls"] += 1
        dom["input_tokens"] += r.input_tokens
        dom["output_tokens"] += r.output_tokens

    return {
        "total_cost_usd": total_cost,
        "total_input_tokens": total_in,
        "total_output_tokens": total_out,
        "call_count": len(rows),
        "by_model": sorted(
            [{"model": k, **v} for k, v in by_model.items()],
            key=lambda x: -x["cost_usd"],
        ),
        "by_day": sorted(
            [{"date": k, **v} for k, v in by_day.items()],
            key=lambda x: x["date"],
        ),
        "by_domain": sorted(
            [{"domain": k, **v} for k, v in by_domain.items()],
            key=lambda x: -x["cost_usd"],
        ),
        "recent_calls": [
            {
                "job_id": r.job_id, "model": r.model, "backend": r.backend, "profile": r.profile,
                "domain": r.domain, "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
                "cost_usd": r.cost_usd, "created_at": r.created_at.isoformat(),
            }
            for r in rows[:50]
        ],
    }


DOMAINS = ("business", "work", "personal", "general")


async def check_spend_cap(domain: str = "general") -> dict:
    """Best-effort check against config.py's optional daily spend caps.
    Returns exceeded=False (never blocks) if no cap is configured or the
    check itself fails — a broken cap check must never take Naxie down."""
    from config import get_settings
    settings = get_settings()
    daily_cap = settings.daily_spend_cap_usd
    domain_cap = settings.domain_daily_spend_cap_usd

    result = {
        "exceeded": False,
        "domain": domain,
        "spent_today_usd": 0.0,
        "spent_today_domain_usd": 0.0,
        "daily_cap_usd": daily_cap,
        "domain_cap_usd": domain_cap,
    }
    if daily_cap is None and domain_cap is None:
        return result

    try:
        from sqlalchemy import select, func
        from database import async_session, CostRecord

        start_of_today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        async with async_session() as db:
            total = (await db.execute(
                select(func.coalesce(func.sum(CostRecord.cost_usd), 0.0)).where(CostRecord.created_at >= start_of_today)
            )).scalar_one()
            domain_total = (await db.execute(
                select(func.coalesce(func.sum(CostRecord.cost_usd), 0.0)).where(
                    CostRecord.created_at >= start_of_today, CostRecord.domain == domain,
                )
            )).scalar_one()

        result["spent_today_usd"] = float(total)
        result["spent_today_domain_usd"] = float(domain_total)
        result["exceeded"] = (daily_cap is not None and total >= daily_cap) or (
            domain_cap is not None and domain_total >= domain_cap
        )
    except Exception as e:
        logger.warning(f"[CostTracker] spend cap check failed (allowing call): {e}")

    return result
