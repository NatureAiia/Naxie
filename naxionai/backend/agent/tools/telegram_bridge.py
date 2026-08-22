"""
NAXIONAI — Telegram bridge

Modeled on neuroworks/server/src/lib/telegram-bridge.ts: long-polls the
Telegram Bot API (no python-telegram-bot dependency needed — same reasoning
as the TS original, which hand-rolls its own `getUpdates`/`sendMessage`
calls over plain HTTP), gated by a chat-id allow-list, with group-mention
gating so the bot only acts in a group when actually addressed.

Architectural choice (matches the TS original's own reasoning, see its
top-of-file comment): an inbound Telegram message is turned into an internal
loopback call to this SAME process's `/api/chat/stream` endpoint rather than
calling into agent/graph.py directly — a Telegram turn then looks, and
behaves, exactly like a normal chat-UI turn (persona/governance/playbook
context all apply identically), and this file never needs to duplicate any
of that logic or be kept in sync with it. Follow-up messages an agent node
pushes later via chat_push() are fanned out separately (see chat_push.py).

Simplification versus the TS original: that version needs a cross-process
file lock because NeuroWorks can run several worker processes sharing one
bot token. NAXIONAI runs as a single process by default, so `poll_telegram`
assumes it's the only consumer of `getUpdates` for this bot token.
"""

import asyncio
import logging
from typing import Optional

import httpx

from agent.tools.messaging_bridge import resolve_user_id_for_channel, run_chat_turn
from config import get_settings

logger = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org"
POLL_TIMEOUT_S = 25
MAX_MESSAGE_CHARS = 4096

_offset: Optional[int] = None
_bot_username: Optional[str] = None


def _allowed_chats() -> set[str]:
    settings = get_settings()
    return {c.strip() for c in settings.telegram_allowed_chats.split(",") if c.strip()}


async def _tg(method: str, **params) -> dict:
    settings = get_settings()
    url = f"{TELEGRAM_API}/bot{settings.telegram_bot_token}/{method}"
    async with httpx.AsyncClient(timeout=POLL_TIMEOUT_S + 10) as client:
        resp = await client.post(url, json=params)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram API error on {method}: {data}")
    return data.get("result")


async def send_telegram_message(chat_id, text: str) -> None:
    # No parse_mode — a malformed Markdown/HTML fragment in an LLM-generated
    # reply would otherwise make Telegram reject the whole send.
    for i in range(0, len(text), MAX_MESSAGE_CHARS):
        await _tg("sendMessage", chat_id=chat_id, text=text[i:i + MAX_MESSAGE_CHARS])


async def _handle_update(update: dict) -> None:
    message = update.get("message") or update.get("edited_message")
    if not message or "text" not in message:
        return

    chat = message.get("chat", {})
    chat_id = chat.get("id")
    chat_type = chat.get("type", "private")
    text = message["text"]

    if str(chat_id) not in _allowed_chats():
        logger.info("[Telegram] Dropped message from non-allow-listed chat %s", chat_id)
        return

    if chat_type in ("group", "supergroup"):
        mention = f"@{_bot_username}" if _bot_username else None
        reply_to_bot = (
            message.get("reply_to_message", {}).get("from", {}).get("username") == _bot_username
            if _bot_username else False
        )
        if not reply_to_bot and not (mention and mention.lower() in text.lower()):
            return
        if mention:
            text = text.replace(mention, "").replace(mention.lower(), "").strip()

    user_id = await resolve_user_id_for_channel("telegram", chat_id)
    try:
        reply = await run_chat_turn(user_id, text)
    except Exception as e:
        logger.error("[Telegram] Chat turn failed for chat %s: %s", chat_id, e)
        reply = "Sorry, something went wrong handling that — please try again."
    await send_telegram_message(chat_id, reply)


async def poll_telegram() -> None:
    """Long-poll loop — call once at app startup (see main.py). Disabled
    (returns immediately) if TELEGRAM_BOT_TOKEN isn't configured, matching
    poll_email_inbox()'s convention for optional integrations."""
    global _offset, _bot_username

    settings = get_settings()
    if not settings.telegram_bot_token:
        logger.info("[Telegram] TELEGRAM_BOT_TOKEN not set — bridge disabled.")
        return
    if not _allowed_chats():
        logger.info("[Telegram] TELEGRAM_ALLOWED_CHATS is empty — inbound disabled (bot will not respond to anyone).")
        return

    try:
        me = await _tg("getMe")
        _bot_username = me.get("username")
        logger.info("[Telegram] Bridge starting as @%s", _bot_username)
    except Exception as e:
        logger.error("[Telegram] getMe failed, bridge not starting: %s", e)
        return

    # Drain any backlog so a restart doesn't replay old messages.
    try:
        backlog = await _tg("getUpdates", offset=-1, timeout=0)
        if backlog:
            _offset = backlog[-1]["update_id"] + 1
    except Exception as e:
        logger.warning("[Telegram] Backlog drain failed (continuing from scratch): %s", e)

    while True:
        try:
            updates = await _tg("getUpdates", offset=_offset, timeout=POLL_TIMEOUT_S)
            for update in updates:
                _offset = update["update_id"] + 1
                try:
                    await _handle_update(update)
                except Exception as e:
                    logger.error("[Telegram] Failed to handle update %s: %s", update.get("update_id"), e)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 409:
                # Another getUpdates consumer is active for this token.
                logger.warning("[Telegram] 409 conflict — another poller is using this bot token. Backing off.")
                await asyncio.sleep(60)
            else:
                logger.warning("[Telegram] HTTP error: %s", e)
                await asyncio.sleep(5)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("[Telegram] Poll loop error: %s", e)
            await asyncio.sleep(5)
