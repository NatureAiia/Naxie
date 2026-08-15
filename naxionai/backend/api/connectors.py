"""
NAXIONAI — Connectors API (Phase 5)

Generic HTTP connectors — distinct from api/accounts.py's social-publishing
PlatformConnection rows, but the same table (platform="custom_connector").
"""

import json
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, PlatformConnection
from auth import get_current_user, layer_of_role
from encryption import encrypt_value, decrypt_value
import connector_client as cc

router = APIRouter(prefix="/api/connectors", tags=["connectors"])

PLATFORM = "custom_connector"


def _is_admin(user) -> bool:
    return layer_of_role((user or {}).get("role")) in ("admin", "superadmin")


class ConnectorAuthIn(BaseModel):
    type: str = "none"  # none | api_key | bearer | basic | header
    location: str = "header"  # for api_key: "header" | "query"
    name: Optional[str] = None
    username: Optional[str] = None
    secret: Optional[str] = None  # value / token / password, depending on type


class ConnectorOut(BaseModel):
    id: str
    label: str
    base_url: str
    description: Optional[str] = None
    auth_type: str
    auth_name: Optional[str] = None
    auth_username: Optional[str] = None
    auth_location: str = "header"
    secret_set: bool
    headers: Dict[str, str] = {}
    endpoints: List[dict] = []
    write_enabled: bool
    is_enabled: bool
    connection_status: str


def _out(c: PlatformConnection) -> ConnectorOut:
    extra = json.loads(c.extra_config) if c.extra_config else {}
    return ConnectorOut(
        id=c.id, label=c.display_name, base_url=c.base_url or "", description=extra.get("description"),
        auth_type=c.auth_type or "none", auth_name=extra.get("auth_name"), auth_username=c.web_username,
        auth_location=extra.get("auth_location", "header"),
        secret_set=bool(c.api_key_encrypted), headers=extra.get("headers", {}),
        endpoints=json.loads(c.endpoints) if c.endpoints else [],
        write_enabled=c.write_enabled, is_enabled=c.is_enabled, connection_status=c.connection_status,
    )


def _owner_scope(stmt, user):
    if _is_admin(user):
        return stmt
    return stmt.where(PlatformConnection.owner_id == user.get("sub"))


@router.get("/", response_model=List[ConnectorOut])
async def list_connectors(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    rows = (await db.execute(_owner_scope(
        select(PlatformConnection).where(PlatformConnection.platform == PLATFORM), user
    ))).scalars().all()
    return [_out(c) for c in rows]


class CreateConnectorRequest(BaseModel):
    label: str
    base_url: str
    description: Optional[str] = None
    auth: ConnectorAuthIn = ConnectorAuthIn()
    headers: Dict[str, str] = {}
    endpoints: List[dict] = []
    write_enabled: bool = False


def _validate_base_url(base_url: str) -> str:
    from urllib.parse import urlparse
    base_url = base_url.strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(400, f"base_url must be a valid http(s) URL: {base_url}")
    return base_url


@router.post("/", response_model=ConnectorOut)
async def create_connector(body: CreateConnectorRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    if body.auth.type not in ("none", "api_key", "bearer", "basic", "header"):
        raise HTTPException(400, "auth.type must be none, api_key, bearer, basic, or header")
    base_url = _validate_base_url(body.base_url)
    row = PlatformConnection(
        id=str(uuid.uuid4()), owner_id=user.get("sub"), platform=PLATFORM,
        display_name=body.label.strip(), account_label=body.label.strip()[:100],
        base_url=base_url, auth_type=body.auth.type,
        api_key_encrypted=encrypt_value(body.auth.secret) if body.auth.secret else None,
        web_username=body.auth.username, write_enabled=body.write_enabled,
        endpoints=json.dumps(body.endpoints) if body.endpoints else None,
        extra_config=json.dumps({
            "description": body.description, "auth_name": body.auth.name,
            "auth_location": body.auth.location, "headers": body.headers,
        }),
        is_enabled=True, connection_status="connected" if body.auth.type == "none" else "disconnected",
    )
    db.add(row)
    await db.commit()
    return _out(row)


class UpdateConnectorRequest(BaseModel):
    label: Optional[str] = None
    base_url: Optional[str] = None
    description: Optional[str] = None
    auth: Optional[ConnectorAuthIn] = None
    headers: Optional[Dict[str, str]] = None
    endpoints: Optional[List[dict]] = None
    write_enabled: Optional[bool] = None


@router.patch("/{connector_id}", response_model=ConnectorOut)
async def update_connector(connector_id: str, body: UpdateConnectorRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(_owner_scope(
        select(PlatformConnection).where(PlatformConnection.id == connector_id, PlatformConnection.platform == PLATFORM), user
    ))).scalars().first()
    if not row:
        raise HTTPException(404, "Connector not found")
    extra = json.loads(row.extra_config) if row.extra_config else {}
    if body.label is not None:
        row.display_name = body.label.strip()
        row.account_label = body.label.strip()[:100]
    if body.base_url is not None:
        row.base_url = _validate_base_url(body.base_url)
    if body.description is not None:
        extra["description"] = body.description
    if body.auth is not None:
        if body.auth.type not in ("none", "api_key", "bearer", "basic", "header"):
            raise HTTPException(400, "auth.type must be none, api_key, bearer, basic, or header")
        row.auth_type = body.auth.type
        if body.auth.secret:  # blank means "unchanged", matching the TS original's UI convention
            row.api_key_encrypted = encrypt_value(body.auth.secret)
        row.web_username = body.auth.username
        extra["auth_name"] = body.auth.name
        extra["auth_location"] = body.auth.location
    if body.headers is not None:
        extra["headers"] = body.headers
    if body.endpoints is not None:
        row.endpoints = json.dumps(body.endpoints)
    if body.write_enabled is not None:
        row.write_enabled = body.write_enabled
    row.extra_config = json.dumps(extra)
    await db.commit()
    return _out(row)


@router.delete("/{connector_id}")
async def delete_connector(connector_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(_owner_scope(
        select(PlatformConnection).where(PlatformConnection.id == connector_id, PlatformConnection.platform == PLATFORM), user
    ))).scalars().first()
    if not row:
        raise HTTPException(404, "Connector not found")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted"}


async def _load_for_call(db: AsyncSession, connector_id: str, user: dict) -> PlatformConnection:
    row = (await db.execute(_owner_scope(
        select(PlatformConnection).where(PlatformConnection.id == connector_id, PlatformConnection.platform == PLATFORM), user
    ))).scalars().first()
    if not row:
        raise HTTPException(404, "Connector not found")
    return row


class CallRequest(BaseModel):
    method: str = "GET"
    path: str = ""
    query: Dict[str, Any] = {}
    body: Any = None
    headers: Dict[str, str] = {}


@router.post("/{connector_id}/call")
async def call_connector_endpoint(connector_id: str, body: CallRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await _load_for_call(db, connector_id, user)
    extra = json.loads(row.extra_config) if row.extra_config else {}
    secret = decrypt_value(row.api_key_encrypted) if row.api_key_encrypted else None
    result = await cc.call_connector(
        base_url=row.base_url, write_enabled=row.write_enabled, auth_type=row.auth_type or "none",
        secret=secret, auth_name=extra.get("auth_name"), auth_in=extra.get("auth_location", "header"),
        auth_username=row.web_username, static_headers=extra.get("headers", {}),
        method=body.method, path=body.path, query=body.query, body=body.body, extra_headers=body.headers,
    )
    return result


@router.post("/{connector_id}/test")
async def test_connector_endpoint(connector_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await _load_for_call(db, connector_id, user)
    extra = json.loads(row.extra_config) if row.extra_config else {}
    secret = decrypt_value(row.api_key_encrypted) if row.api_key_encrypted else None
    endpoints = json.loads(row.endpoints) if row.endpoints else []
    probe_path = next((e["path"] for e in endpoints if e.get("method") == "GET"), "/")
    result = await cc.test_connector(
        base_url=row.base_url, write_enabled=row.write_enabled, auth_type=row.auth_type or "none",
        secret=secret, auth_name=extra.get("auth_name"), auth_in=extra.get("auth_location", "header"),
        auth_username=row.web_username, static_headers=extra.get("headers", {}), probe_path=probe_path,
    )
    row.connection_status = "connected" if result["ok"] else "error"
    row.error_message = None if result["ok"] else result["detail"]
    await db.commit()
    return result


@router.post("/seed-public-apis")
async def seed_public_apis(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    """Idempotent (by label) — seeds the free, keyless public-API connectors.
    Safe to call repeatedly; existing labels are skipped."""
    existing = {c.display_name.lower() for c in (await db.execute(
        select(PlatformConnection).where(PlatformConnection.platform == PLATFORM, PlatformConnection.owner_id == user.get("sub"))
    )).scalars().all()}
    created = []
    for spec in cc.PUBLIC_API_SEEDS:
        if spec["label"].lower() in existing:
            continue
        row = PlatformConnection(
            id=str(uuid.uuid4()), owner_id=user.get("sub"), platform=PLATFORM,
            display_name=spec["label"], account_label=spec["label"][:100],
            base_url=spec["base_url"], auth_type="none", write_enabled=False,
            endpoints=json.dumps(spec["endpoints"]),
            extra_config=json.dumps({"description": spec["description"], "auth_location": "header", "headers": {}}),
            is_enabled=True, connection_status="connected",
        )
        db.add(row)
        created.append(spec["label"])
    if created:
        await db.commit()
    return {"created": created}
