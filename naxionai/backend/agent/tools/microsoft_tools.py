"""
NAXIONAI — Agent Microsoft Graph Tools (Outlook Mail + Calendar + OneDrive)

Plain async helpers (not FastAPI routes) that other agent code — notably the
autonomous daemon's digest — calls directly. Every function here has a
fail-safe contract: any missing connection, expired auth, or HTTP error
returns an empty list rather than raising, since a Graph hiccup must never
take down the daemon.

Usage:
    from agent.tools.microsoft_tools import list_upcoming_events, list_recent_emails, list_recent_files
"""

import logging

import httpx

from database import async_session, PlatformConnection
from sqlalchemy import select
from api.microsoft_connector import _get_valid_access_token

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
PLATFORM = "microsoft"


async def _get_connection(user_id: str):
    async with async_session() as db:
        return (await db.execute(select(PlatformConnection).where(
            PlatformConnection.platform == PLATFORM,
            PlatformConnection.owner_id == user_id,
            PlatformConnection.is_enabled == True,  # noqa: E712
        ))).scalars().first()


async def list_upcoming_events(user_id: str, max_results: int = 5) -> list[dict]:
    """Returns upcoming Outlook Calendar events for `user_id`, or [] if not connected / on any error."""
    try:
        connection = await _get_connection(user_id)
        if not connection:
            return []
        access_token = await _get_valid_access_token(connection)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GRAPH_BASE}/me/events",
                headers={"Authorization": f"Bearer {access_token}"},
                params={"$top": max_results, "$orderby": "start/dateTime", "$select": "subject,start"},
            )
            resp.raise_for_status()
            data = resp.json()
        return [
            {"title": item.get("subject", ""), "start": (item.get("start") or {}).get("dateTime", "")}
            for item in data.get("value", [])
        ]
    except Exception as e:
        logger.warning(f"[MicrosoftTools] list_upcoming_events failed for user {user_id}: {e}")
        return []


async def list_recent_emails(user_id: str, max_results: int = 5) -> list[dict]:
    """Returns unread Outlook Mail metadata (subject/from only) for `user_id`, or [] if not connected / on error."""
    try:
        connection = await _get_connection(user_id)
        if not connection:
            return []
        access_token = await _get_valid_access_token(connection)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GRAPH_BASE}/me/messages",
                headers={"Authorization": f"Bearer {access_token}"},
                params={"$top": max_results, "$filter": "isRead eq false", "$select": "subject,from"},
            )
            resp.raise_for_status()
            data = resp.json()
        return [
            {
                "subject": item.get("subject", ""),
                "from": ((item.get("from") or {}).get("emailAddress") or {}).get("address", ""),
            }
            for item in data.get("value", [])
        ]
    except Exception as e:
        logger.warning(f"[MicrosoftTools] list_recent_emails failed for user {user_id}: {e}")
        return []


async def list_recent_files(user_id: str, max_results: int = 10) -> list[dict]:
    """Returns recently-modified OneDrive files for `user_id`, or [] if not connected / on any error."""
    try:
        connection = await _get_connection(user_id)
        if not connection:
            return []
        access_token = await _get_valid_access_token(connection)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GRAPH_BASE}/me/drive/root/children",
                headers={"Authorization": f"Bearer {access_token}"},
                params={"$top": max_results, "$orderby": "lastModifiedDateTime desc", "$select": "name,webUrl,lastModifiedDateTime"},
            )
            resp.raise_for_status()
            data = resp.json()
        return [
            {"name": item.get("name", ""), "url": item.get("webUrl", ""), "modified": item.get("lastModifiedDateTime", "")}
            for item in data.get("value", [])
        ]
    except Exception as e:
        logger.warning(f"[MicrosoftTools] list_recent_files failed for user {user_id}: {e}")
        return []
