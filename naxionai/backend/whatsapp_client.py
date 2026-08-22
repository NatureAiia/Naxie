"""
NAXIONAI — WhatsApp Cloud API client

Built from scratch — unlike Telegram, neither neuroworks nor naxionai has a
real WhatsApp bridge to port (neuroworks' "whatsapp" entry is a static
Integrations-page catalog card, `testable: false`, no code behind it).
Uses the same origin-locked httpx pattern as connector_client.py/
github_client.py, hardcoded to Meta's Graph API host.
"""

import logging

import httpx

from config import get_settings
from connector_client import ConnectorError, resolve_url

logger = logging.getLogger(__name__)

GRAPH_API_VERSION = "v19.0"
# NOTE: resolve_url()'s path-joining treats a leading "/" in `path` as
# absolute (urljoin semantics) — it DROPS any path segment already in
# base_url. Verified: resolve_url("https://graph.facebook.com/v19.0",
# "/x") -> "https://graph.facebook.com/x" (v19.0 silently lost). Keep the
# base as bare origin and put the full versioned path in every call instead.
GRAPH_API_BASE = "https://graph.facebook.com"
TIMEOUT_SECONDS = 30.0


class WhatsAppError(Exception):
    pass


async def send_whatsapp_message(phone_number: str, text: str) -> None:
    settings = get_settings()
    if not settings.whatsapp_phone_number_id or not settings.whatsapp_access_token:
        raise WhatsAppError("WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not configured")

    try:
        url = resolve_url(GRAPH_API_BASE, f"/{GRAPH_API_VERSION}/{settings.whatsapp_phone_number_id}/messages")
    except ConnectorError as e:
        raise WhatsAppError(str(e))

    payload = {
        "messaging_product": "whatsapp",
        "to": phone_number,
        "type": "text",
        "text": {"body": text},
    }
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        resp = await client.post(url, headers={"authorization": f"Bearer {settings.whatsapp_access_token}"}, json=payload)
    if resp.status_code >= 400:
        raise WhatsAppError(f"WhatsApp send failed: HTTP {resp.status_code} — {resp.text[:300]}")
