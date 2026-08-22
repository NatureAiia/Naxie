"""
NAXIONAI — Microsoft OAuth Connector (Outlook Mail + Calendar + OneDrive)

Real OAuth2 (authorization-code + refresh) against the Microsoft identity
platform / Graph API. Structurally parallel to api/google_connector.py, but
uses Microsoft's v2.0 endpoints and a signed `state` param instead of a
session cookie, since Microsoft's redirect back to our server is a plain
browser GET with no Authorization header (see callback below).

Uses the same PlatformConnection table as api/connectors.py (platform=
"microsoft" here), reusing existing columns — granted scopes and token
expiry are stashed as JSON in extra_config rather than new DB columns.
"""

import hashlib
import hmac
import json
import logging
import time
import uuid
from typing import List, Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException
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

router = APIRouter(prefix="/api/connectors/microsoft", tags=["connectors-microsoft"])

PLATFORM = "microsoft"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"
SCOPES = "offline_access Mail.Read Calendars.Read Files.Read User.Read"
STATE_TTL_SECONDS = 600  # 10 minutes to complete the consent flow


def _authority(path: str) -> str:
    return f"https://login.microsoftonline.com/{settings.microsoft_tenant_id}/oauth2/v2.0/{path}"


def _sign_state(user_id: str, expires_at: int) -> str:
    payload = f"{user_id}:{expires_at}"
    sig = hmac.new(settings.jwt_secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{sig}"


def _verify_state(state: str) -> Optional[str]:
    """Returns the user id if `state` is a validly-signed, unexpired token; None otherwise."""
    try:
        user_id, expires_at, sig = state.rsplit(":", 2)
    except ValueError:
        return None
    payload = f"{user_id}:{expires_at}"
    expected = hmac.new(settings.jwt_secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    if int(expires_at) < int(time.time()):
        return None
    return user_id


def _require_configured():
    if not settings.microsoft_client_id or not settings.microsoft_client_secret:
        raise HTTPException(400, "Microsoft OAuth is not configured — set MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET")


class MicrosoftConnectionOut(BaseModel):
    id: str
    account_name: Optional[str] = None
    connection_status: str
    scopes: Optional[str] = None


def _out(c: PlatformConnection) -> MicrosoftConnectionOut:
    extra = json.loads(c.extra_config) if c.extra_config else {}
    return MicrosoftConnectionOut(
        id=c.id, account_name=c.account_name, connection_status=c.connection_status,
        scopes=extra.get("scope"),
    )


@router.get("/authorize")
async def authorize(user: dict = Depends(get_current_user)):
    _require_configured()
    expires_at = int(time.time()) + STATE_TTL_SECONDS
    state = _sign_state(user.get("sub"), expires_at)
    params = {
        "client_id": settings.microsoft_client_id,
        "redirect_uri": settings.microsoft_redirect_uri,
        "response_type": "code",
        "response_mode": "query",
        "scope": SCOPES,
        "state": state,
    }
    return {"authorize_url": f"{_authority('authorize')}?{urlencode(params)}"}


@router.get("/callback")
async def callback(code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None,
                    db: AsyncSession = Depends(get_db)):
    frontend = settings.frontend_url.rstrip("/")
    if error:
        return RedirectResponse(f"{frontend}/connectors?error={error}")
    if not code or not state:
        return RedirectResponse(f"{frontend}/connectors?error=missing_code_or_state")

    user_id = _verify_state(state)
    if not user_id:
        return RedirectResponse(f"{frontend}/connectors?error=invalid_or_expired_state")

    try:
        _require_configured()
        async with httpx.AsyncClient(timeout=20) as client:
            token_resp = await client.post(_authority("token"), data={
                "client_id": settings.microsoft_client_id,
                "client_secret": settings.microsoft_client_secret,
                "code": code,
                "redirect_uri": settings.microsoft_redirect_uri,
                "grant_type": "authorization_code",
                "scope": SCOPES,
            })
            token_resp.raise_for_status()
            tokens = token_resp.json()

            access_token = tokens["access_token"]
            refresh_token = tokens.get("refresh_token", "")

            me_resp = await client.get(f"{GRAPH_BASE}/me", headers={"Authorization": f"Bearer {access_token}"})
            me_resp.raise_for_status()
            me = me_resp.json()
    except Exception as e:
        logger.error(f"[MicrosoftConnector] OAuth callback failed: {e}")
        return RedirectResponse(f"{frontend}/connectors?error=token_exchange_failed")

    account_name = me.get("mail") or me.get("userPrincipalName") or me.get("displayName") or ""
    expires_at = int(time.time()) + int(tokens.get("expires_in", 3600))
    extra = {"scope": tokens.get("scope", SCOPES), "expires_at": expires_at}

    row = (await db.execute(
        select(PlatformConnection).where(PlatformConnection.platform == PLATFORM, PlatformConnection.owner_id == user_id)
    )).scalars().first()
    if row is None:
        row = PlatformConnection(id=str(uuid.uuid4()), owner_id=user_id, platform=PLATFORM, display_name="Microsoft")
        db.add(row)

    row.display_name = "Microsoft"
    row.account_name = account_name
    row.account_id = me.get("id")
    row.access_token_encrypted = encrypt_value(access_token)
    if refresh_token:
        row.refresh_token_encrypted = encrypt_value(refresh_token)
    row.extra_config = json.dumps(extra)
    row.is_enabled = True
    row.connection_status = "connected"
    row.error_message = None
    await db.commit()

    return RedirectResponse(f"{frontend}/connectors?connected=microsoft")


@router.get("/", response_model=List[MicrosoftConnectionOut])
async def list_connections(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    rows = (await db.execute(
        select(PlatformConnection).where(PlatformConnection.platform == PLATFORM, PlatformConnection.owner_id == user.get("sub"))
    )).scalars().all()
    return [_out(c) for c in rows]


@router.delete("/{connection_id}")
async def disconnect(connection_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(PlatformConnection).where(
        PlatformConnection.id == connection_id, PlatformConnection.platform == PLATFORM, PlatformConnection.owner_id == user.get("sub"),
    ))).scalars().first()
    if not row:
        raise HTTPException(404, "Microsoft connection not found")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted"}


async def _refresh_tokens(row: PlatformConnection) -> str:
    """Exchanges the stored refresh_token for a fresh access_token, updating `row` in place.
    Raises HTTPException(400) if there's no refresh_token to use."""
    if not row.refresh_token_encrypted:
        raise HTTPException(400, "No refresh token stored for this Microsoft connection — reconnect required")

    refresh_token = decrypt_value(row.refresh_token_encrypted)
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(_authority("token"), data={
            "client_id": settings.microsoft_client_id,
            "client_secret": settings.microsoft_client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
            "scope": SCOPES,
        })
        resp.raise_for_status()
        tokens = resp.json()

    access_token = tokens["access_token"]
    row.access_token_encrypted = encrypt_value(access_token)
    if tokens.get("refresh_token"):  # Microsoft often rotates it
        row.refresh_token_encrypted = encrypt_value(tokens["refresh_token"])
    extra = json.loads(row.extra_config) if row.extra_config else {}
    extra["expires_at"] = int(time.time()) + int(tokens.get("expires_in", 3600))
    extra["scope"] = tokens.get("scope", extra.get("scope", SCOPES))
    row.extra_config = json.dumps(extra)
    row.connection_status = "connected"
    row.error_message = None
    return access_token


@router.post("/{connection_id}/refresh")
async def refresh_connection(connection_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(PlatformConnection).where(
        PlatformConnection.id == connection_id, PlatformConnection.platform == PLATFORM, PlatformConnection.owner_id == user.get("sub"),
    ))).scalars().first()
    if not row:
        raise HTTPException(404, "Microsoft connection not found")
    await _refresh_tokens(row)
    await db.commit()
    return _out(row)


async def _get_valid_access_token(connection: PlatformConnection) -> str:
    """Returns a usable access token for `connection`, transparently refreshing
    it (and persisting the refresh via a fresh db session) if expired."""
    extra = json.loads(connection.extra_config) if connection.extra_config else {}
    expires_at = extra.get("expires_at", 0)
    if expires_at > int(time.time()) + 30 and connection.access_token_encrypted:  # 30s safety margin
        return decrypt_value(connection.access_token_encrypted)

    from database import async_session
    async with async_session() as db:
        row = (await db.execute(select(PlatformConnection).where(PlatformConnection.id == connection.id))).scalars().first()
        if row is None:
            raise HTTPException(404, "Microsoft connection not found")
        access_token = await _refresh_tokens(row)
        await db.commit()
        return access_token
