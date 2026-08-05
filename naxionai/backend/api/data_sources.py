"""
NAXIONAI — Data Sources API (Phase 5)
"""

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, DataSource
from auth import get_current_user
from encryption import encrypt_value, decrypt_value
from api.governance import get_enforceable_constraints
import data_source_client as dsc
import governance as gov

router = APIRouter(prefix="/api/data-sources", tags=["data-sources"])

VALID_KINDS = ("postgres", "mysql", "sqlite", "mssql", "mongodb", "excel", "csv")


class DataSourceOut(BaseModel):
    id: str
    label: str
    kind: str
    connection_redacted: str
    notes: Optional[str] = None
    department: Optional[str] = None
    readonly: bool


def _out(d: DataSource) -> DataSourceOut:
    try:
        conn = decrypt_value(d.connection_encrypted)
    except Exception:
        conn = ""
    return DataSourceOut(
        id=d.id, label=d.label, kind=d.kind, connection_redacted=dsc.redact_connection(conn, d.kind),
        notes=d.notes, department=d.department, readonly=d.readonly,
    )


@router.get("/", response_model=List[DataSourceOut])
async def list_sources(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    rows = (await db.execute(select(DataSource).where(DataSource.owner_id == user.get("sub")))).scalars().all()
    return [_out(d) for d in rows]


class CreateDataSourceRequest(BaseModel):
    label: str
    kind: str
    connection: str
    notes: Optional[str] = None
    department: Optional[str] = None
    readonly: bool = True


@router.post("/", response_model=DataSourceOut)
async def create_source(body: CreateDataSourceRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    if body.kind not in VALID_KINDS:
        raise HTTPException(400, f"kind must be one of {', '.join(VALID_KINDS)}")
    row = DataSource(
        id=str(uuid.uuid4()), owner_id=user.get("sub"), label=body.label.strip(), kind=body.kind,
        connection_encrypted=encrypt_value(body.connection), notes=body.notes,
        department=body.department, readonly=body.readonly,
    )
    db.add(row)
    await db.commit()
    return _out(row)


@router.delete("/{source_id}")
async def delete_source(source_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(DataSource).where(DataSource.id == source_id))).scalars().first()
    if not row or row.owner_id != user.get("sub"):
        raise HTTPException(404, "Data source not found")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted"}


async def _load(db: AsyncSession, source_id: str, user: dict) -> DataSource:
    row = (await db.execute(select(DataSource).where(DataSource.id == source_id))).scalars().first()
    if not row or row.owner_id != user.get("sub"):
        raise HTTPException(404, "Data source not found")
    return row


class QueryRequest(BaseModel):
    sql: str
    limit: int = 200


@router.post("/{source_id}/query")
async def query_source(source_id: str, body: QueryRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await _load(db, source_id, user)

    if not row.readonly:
        enforceable = await get_enforceable_constraints(db, user.get("sub"))
        if enforceable:
            action = gov.describe_step_action("db.write", {"kind": row.kind, "code": body.sql})
            gate = gov.gate_action(action, enforceable)
            if gate["blocked"]:
                raise HTTPException(403, f"Blocked by governance policy: {gate['violations']}")

    connection = decrypt_value(row.connection_encrypted)
    try:
        return await dsc.run_query(row.kind, connection, body.sql, row.readonly, min(body.limit, 2000))
    except (ValueError, PermissionError) as e:
        raise HTTPException(400, str(e))


@router.get("/{source_id}/schema")
async def describe_source(source_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await _load(db, source_id, user)
    connection = decrypt_value(row.connection_encrypted)
    try:
        return await dsc.describe_source(row.kind, connection)
    except (ValueError, PermissionError) as e:
        raise HTTPException(400, str(e))
