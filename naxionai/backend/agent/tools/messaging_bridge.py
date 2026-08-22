"""
NAXIONAI — Shared messaging-bridge helpers

Common logic for every external chat channel (Telegram, WhatsApp, and any
future one): map an external chat identity to a NAXIONAI user, and run a
chat turn through the SAME internal path a web-UI message takes
(`/api/chat/stream`, called via an in-process ASGI loopback — no real HTTP
socket, no extra auth roundtrip). See telegram_bridge.py's module docstring
for why a loopback call was chosen over calling agent/graph.py directly.
"""

import json
import logging

import httpx

from config import get_settings

logger = logging.getLogger(__name__)


async def resolve_user_id_for_channel(channel: str, external_id) -> str:
    """Map an external chat identity to the NAXIONAI user it should act as.
    Falls back to the single local-mode user when no explicit MessagingLink
    row exists — matching naxionai's default single-user posture."""
    try:
        from sqlalchemy import select

        from database import MessagingLink, async_session
        async with async_session() as db:
            link = (await db.execute(
                select(MessagingLink).where(MessagingLink.channel == channel, MessagingLink.external_id == str(external_id))
            )).scalars().first()
            if link:
                return link.user_id
    except Exception as e:
        logger.warning("[MessagingBridge] Link lookup failed for %s/%s, falling back to local user: %s", channel, external_id, e)

    from database import ensure_default_user
    local_user = await ensure_default_user()
    return local_user["sub"]


async def run_chat_turn(user_id: str, message: str) -> str:
    """Loopback call into this same process's /api/chat/stream, so an
    inbound channel message goes through the exact same persona/governance/
    playbook logic a web-UI chat message does."""
    from main import app

    settings = get_settings()
    headers = {}
    if settings.require_auth:
        from auth import create_access_token
        headers["authorization"] = f"Bearer {create_access_token({'sub': user_id})}"

    reply_parts: list[str] = []
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://internal", timeout=90) as client:
        async with client.stream("POST", "/api/chat/stream", json={"message": message}, headers=headers) as resp:
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                try:
                    evt = json.loads(line[len("data: "):])
                except (json.JSONDecodeError, ValueError):
                    continue
                if evt.get("type") == "message":
                    reply_parts.append(evt.get("content", ""))
                elif evt.get("type") == "done":
                    break
    return "".join(reply_parts).strip() or "Acknowledged."
