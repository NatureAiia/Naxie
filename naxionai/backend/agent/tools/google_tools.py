"""
NAXIONAI — Agent Google Tools (Gmail + Calendar)
Read-only helpers over the user's connected Google account. Called from the
autonomous daemon's digest and other agent code — must never raise; any
lookup/auth/HTTP failure degrades to an empty list.

Usage:
    from agent.tools.google_tools import list_upcoming_events, list_recent_emails

    events = await list_upcoming_events(user_id)
    emails = await list_recent_emails(user_id)
"""

import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy import select

from database import async_session, PlatformConnection
from api.google_connector import _get_valid_access_token

logger = logging.getLogger(__name__)

PLATFORM = "google"
CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages"


async def _get_connection(user_id: str):
    async with async_session() as db:
        return (await db.execute(
            select(PlatformConnection).where(
                PlatformConnection.platform == PLATFORM,
                PlatformConnection.owner_id == user_id,
                PlatformConnection.is_enabled == True,  # noqa: E712
            )
        )).scalars().first()


async def list_upcoming_events(user_id: str, max_results: int = 5) -> list[dict]:
    try:
        connection = await _get_connection(user_id)
        if connection is None:
            return []
        access_token = await _get_valid_access_token(connection)
        params = {
            "timeMin": datetime.now(timezone.utc).isoformat(),
            "maxResults": max_results,
            "singleEvents": "true",
            "orderBy": "startTime",
        }
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                CALENDAR_EVENTS_URL, params=params,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            resp.raise_for_status()
            items = resp.json().get("items", [])
        return [
            {
                "title": item.get("summary", "(no title)"),
                "start": (item.get("start") or {}).get("dateTime") or (item.get("start") or {}).get("date"),
            }
            for item in items
        ]
    except Exception as e:
        logger.warning(f"[GoogleTools] list_upcoming_events failed for user {user_id}: {e}")
        return []


async def list_recent_emails(user_id: str, max_results: int = 5) -> list[dict]:
    try:
        connection = await _get_connection(user_id)
        if connection is None:
            return []
        access_token = await _get_valid_access_token(connection)
        headers = {"Authorization": f"Bearer {access_token}"}
        async with httpx.AsyncClient(timeout=15) as client:
            list_resp = await client.get(
                GMAIL_MESSAGES_URL, params={"maxResults": max_results, "q": "is:unread"}, headers=headers,
            )
            list_resp.raise_for_status()
            message_ids = [m["id"] for m in list_resp.json().get("messages", [])]

            results = []
            for message_id in message_ids:
                detail_resp = await client.get(
                    f"{GMAIL_MESSAGES_URL}/{message_id}",
                    params={
                        "format": "metadata",
                        "metadataHeaders": ["Subject", "From"],  # never fetch the body — privacy + payload size
                    },
                    headers=headers,
                )
                detail_resp.raise_for_status()
                header_list = (detail_resp.json().get("payload") or {}).get("headers", [])
                headers_by_name = {h["name"]: h["value"] for h in header_list}
                results.append({
                    "subject": headers_by_name.get("Subject", "(no subject)"),
                    "from": headers_by_name.get("From", ""),
                })
        return results
    except Exception as e:
        logger.warning(f"[GoogleTools] list_recent_emails failed for user {user_id}: {e}")
        return []
