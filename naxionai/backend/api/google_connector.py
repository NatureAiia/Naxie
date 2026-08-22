"""
NAXIONAI — Google OAuth Connector (Gmail + Calendar)

Real OAuth 2.0 authorization-code flow against Google. The browser round-trips
through Google, so /callback is hit with no Authorization header — it can't
depend on get_current_user like every other route here. Instead /authorize
mints a signed `state` (HMAC over "<user_id>:<expires_at>") that /callback
verifies to recover the user id, closing the CSRF hole that a bare state
value would leave open.
"""

import hashlib
import hmac
import json
import logging
import time
import uuid
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, PlatformConnection
from auth import get_current_user
from encryption import encrypt_value, decrypt_value
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/connectors/google", tags=["connectors-google"])

PLATFORM = "google"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
SCOPES = (
    "https://www.googleapis.com/auth/gmail.readonly "
    "https://www.googleapis.com/auth/calendar.readonly "
    "https://www.googleapis.com/auth/userinfo.email"
)
STATE_TTL_SECONDS = 600  # 10 minutes — plenty for a user to complete Google's consent screen


def _sign_state(user_id: str) -> str:
    expires_at = int(time.time()) + STATE_TTL_SECONDS
    payload = f"{user_id}:{expires_at}"
    sig = hmac.new(settings.jwt_secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"


def _verify_state(state: str) -> str:
    """Returns the user id if state is well-formed, unexpired, and correctly signed."""
    try:
        user_id, expires_at, sig = state.rsplit(":", 2)
    except ValueError:
        raise HTTPException(400, "Malformed state parameter")
    payload = f"{user_id}:{expires_at}"
    expected = hmac.new(settings.jwt_secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(400, "Invalid state parameter")
    if int(expires_at) < time.time():
        raise HTTPException(400, "State parameter expired — please reconnect")
    return user_id


def _owner_scope(stmt, user_id: str):
    return stmt.where(PlatformConnection.owner_id == user_id, PlatformConnection.platform == PLATFORM)


class GoogleConnectionOut(BaseModel):
    id: str
    account_name: Optional[str] = None
    connection_status: str
    scopes: Optional[str] = None
    has_refresh_token: bool
    updated_at: Optional[str] = None


def _out(c: PlatformConnection) -> GoogleConnectionOut:
    extra = json.loads(c.extra_config) if c.extra_config else {}
    return GoogleConnectionOut(
        id=c.id, account_name=c.account_name, connection_status=c.connection_status,
        scopes=extra.get("scope"), has_refresh_token=bool(c.refresh_token_encrypted),
        updated_at=c.updated_at.isoformat() if c.updated_at else None,
    )


@router.get("/authorize")
async def authorize(user: dict = Depends(get_current_user)):
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(400, "Google OAuth is not configured — set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET")
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_uri,
        "response_type": "code",
        "access_type": "offline",
        "prompt": "consent",  # forces a refresh_token on every consent, not just the first
        "scope": SCOPES,
        "state": _sign_state(user.get("sub")),
    }
    return {"authorize_url": f"{AUTH_URL}?{urlencode(params)}"}


@router.get("/callback")
async def callback(
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    redirect_base = f"{settings.frontend_url}/connectors"
    if error:
        return RedirectResponse(f"{redirect_base}?error={error}")
    if not code or not state:
        return RedirectResponse(f"{redirect_base}?error=missing_code_or_state")

    try:
        user_id = _verify_state(state)
    except HTTPException as e:
        return RedirectResponse(f"{redirect_base}?error={e.detail}")

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            token_resp = await client.post(TOKEN_URL, data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": settings.google_redirect_uri,
                "grant_type": "authorization_code",
            })
            token_resp.raise_for_status()
            tokens = token_resp.json()

            userinfo_resp = await client.get(
                USERINFO_URL, headers={"Authorization": f"Bearer {tokens['access_token']}"}
            )
            userinfo_resp.raise_for_status()
            email = userinfo_resp.json().get("email")
    except Exception as e:
        logger.error(f"[GoogleConnector] Token exchange failed for user {user_id}: {e}")
        return RedirectResponse(f"{redirect_base}?error=token_exchange_failed")

    expires_at = int(time.time()) + int(tokens.get("expires_in", 3600))
    extra = {"scope": tokens.get("scope", SCOPES), "expires_at": expires_at}

    row = (await db.execute(_owner_scope(select(PlatformConnection), user_id))).scalars().first()
    if row is None:
        row = PlatformConnection(
            id=str(uuid.uuid4()), owner_id=user_id, platform=PLATFORM,
            display_name="Google", account_label="Google",
        )
        db.add(row)

    row.account_name = email
    row.access_token_encrypted = encrypt_value(tokens["access_token"])
    if tokens.get("refresh_token"):  # only present when Google actually grants one
        row.refresh_token_encrypted = encrypt_value(tokens["refresh_token"])
    row.extra_config = json.dumps(extra)
    row.is_enabled = True
    row.connection_status = "connected"
    row.error_message = None
    await db.commit()

    return RedirectResponse(f"{redirect_base}?connected=google")


@router.get("/", response_model=list[GoogleConnectionOut])
async def list_connections(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    rows = (await db.execute(_owner_scope(select(PlatformConnection), user.get("sub")))).scalars().all()
    return [_out(c) for c in rows]


@router.delete("/{connection_id}")
async def disconnect(connection_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(_owner_scope(
        select(PlatformConnection).where(PlatformConnection.id == connection_id), user.get("sub")
    ))).scalars().first()
    if not row:
        raise HTTPException(404, "Google connection not found")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted"}


async def _do_refresh(connection: PlatformConnection) -> str:
    """Unconditionally exchanges the stored refresh_token for a new access
    token and persists it via its own DB session — kept independent of any
    caller's session so agent/tools/google_tools.py can call this without
    threading a session across module boundaries."""
    if not connection.refresh_token_encrypted:
        raise HTTPException(400, "No refresh token stored for this connection — please reconnect Google")
    refresh_token = decrypt_value(connection.refresh_token_encrypted)
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(TOKEN_URL, data={
            "refresh_token": refresh_token,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "grant_type": "refresh_token",
        })
        resp.raise_for_status()
        tokens = resp.json()

    extra = json.loads(connection.extra_config) if connection.extra_config else {}
    extra["expires_at"] = int(time.time()) + int(tokens.get("expires_in", 3600))
    access_token = tokens["access_token"]

    from database import async_session
    async with async_session() as db:
        row = (await db.execute(select(PlatformConnection).where(PlatformConnection.id == connection.id))).scalars().first()
        if row:
            row.access_token_encrypted = encrypt_value(access_token)
            row.extra_config = json.dumps(extra)
            row.connection_status = "connected"
            row.error_message = None
            await db.commit()

    # keep the in-memory object consistent for the rest of the caller's request
    connection.access_token_encrypted = encrypt_value(access_token)
    connection.extra_config = json.dumps(extra)
    connection.connection_status = "connected"
    connection.error_message = None
    return access_token


@router.post("/{connection_id}/refresh")
async def refresh(connection_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(_owner_scope(
        select(PlatformConnection).where(PlatformConnection.id == connection_id), user.get("sub")
    ))).scalars().first()
    if not row:
        raise HTTPException(404, "Google connection not found")
    try:
        await _do_refresh(row)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[GoogleConnector] Refresh failed for connection {connection_id}: {e}")
        raise HTTPException(400, "Failed to refresh Google access token — please reconnect")
    return _out(row)


async def _get_valid_access_token(connection: PlatformConnection) -> str:
    """Returns a usable access token, refreshing it first if it's expired (or
    about to be — a small buffer avoids racing a token that dies mid-request)."""
    extra = json.loads(connection.extra_config) if connection.extra_config else {}
    expires_at = extra.get("expires_at", 0)
    if time.time() < expires_at - 30:
        return decrypt_value(connection.access_token_encrypted)
    return await _do_refresh(connection)
