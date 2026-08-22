"""
NAXIONAI — WhatsApp Cloud API webhook

Genuinely new infrastructure for this backend: every other route here is
called BY the frontend, not by an external provider calling IN. Unlike the
Telegram bridge's long-poll (main.py starts it as a background task and it
needs nothing exposed), this requires a real, public HTTPS endpoint Meta can
reach — ngrok/a tunnel in dev, a real domain + TLS in production. There is
no background task to start for this channel; it's purely push/webhook.
"""

import logging

from fastapi import APIRouter, Query, Request, Response

from agent.tools.messaging_bridge import resolve_user_id_for_channel, run_chat_turn
from config import get_settings
from whatsapp_client import WhatsAppError, send_whatsapp_message

router = APIRouter(prefix="/api/whatsapp", tags=["whatsapp"])
logger = logging.getLogger(__name__)


@router.get("/webhook")
async def verify_webhook(
    hub_mode: str = Query(None, alias="hub.mode"),
    hub_verify_token: str = Query(None, alias="hub.verify_token"),
    hub_challenge: str = Query(None, alias="hub.challenge"),
):
    """Meta's one-time webhook verification handshake."""
    settings = get_settings()
    if not settings.whatsapp_verify_token:
        return Response("WhatsApp bridge not configured", status_code=503)
    if hub_mode == "subscribe" and hub_verify_token == settings.whatsapp_verify_token:
        return Response(content=hub_challenge or "", media_type="text/plain")
    return Response("Verification failed", status_code=403)


@router.post("/webhook")
async def receive_webhook(request: Request):
    settings = get_settings()
    if not settings.whatsapp_phone_number_id or not settings.whatsapp_access_token:
        # Bridge isn't configured — accept and drop rather than 4xx/5xx-ing
        # (Meta retries aggressively on non-2xx responses).
        return {"status": "ignored"}

    body = await request.json()
    for entry in body.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            for message in value.get("messages", []):
                if message.get("type") != "text":
                    continue
                sender = message.get("from")
                text = message.get("text", {}).get("body", "")
                if not sender or not text:
                    continue
                try:
                    user_id = await resolve_user_id_for_channel("whatsapp", sender)
                    reply = await run_chat_turn(user_id, text)
                    await send_whatsapp_message(sender, reply)
                except WhatsAppError as e:
                    logger.error("[WhatsApp] Send failed for %s: %s", sender, e)
                except Exception as e:
                    logger.error("[WhatsApp] Failed to handle message from %s: %s", sender, e)

    return {"status": "ok"}
