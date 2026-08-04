from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional
from pydantic import BaseModel
import uuid

from database import get_db, PlatformConnection
from auth import get_current_user, layer_of_role
from encryption import encrypt_value

router = APIRouter(prefix="/api/accounts", tags=["accounts"])

class AccountCreate(BaseModel):
    platform: str
    display_name: str
    account_label: str
    auth_data: Optional[str] = None
    account_name: Optional[str] = None

class AccountUpdate(BaseModel):
    display_name: Optional[str] = None
    account_label: Optional[str] = None
    auth_data: Optional[str] = None
    is_enabled: Optional[bool] = None

def _is_admin(user) -> bool:
    return layer_of_role((user or {}).get("role")) in ("admin", "superadmin")


def _owner_scope(stmt, current_user):
    """Restrict a PlatformConnection query to the caller's own rows. Admins see
    all (keeps existing single-operator dashboards working); everyone else is
    confined to `owner_id == their user id`, closing the cross-tenant read."""
    if _is_admin(current_user):
        return stmt
    return stmt.where(PlatformConnection.owner_id == current_user.get("sub"))


@router.get("/", response_model=List[dict])
async def list_accounts(db: AsyncSession = Depends(get_db), current_user = Depends(get_current_user)):
    result = await db.execute(_owner_scope(select(PlatformConnection), current_user))
    accounts = result.scalars().all()
    # Do NOT return credential material in the list response. Surface only a
    # boolean so the dashboard can show "credentials set" without exfiltrating
    # secrets to the client (they stay encrypted at rest).
    return [{
        "id": a.id,
        "platform": a.platform,
        "display_name": a.display_name,
        "account_label": a.account_label,
        "account_name": a.account_name,
        "has_auth": bool(a.auth_data),
        "is_enabled": a.is_enabled,
        "connection_status": a.connection_status,
    } for a in accounts]

@router.post("")
async def create_account(account: AccountCreate, db: AsyncSession = Depends(get_db), current_user = Depends(get_current_user)):
    new_account = PlatformConnection(
        id=str(uuid.uuid4()),
        owner_id=current_user.get("sub"),
        platform=account.platform,
        display_name=account.display_name,
        account_label=account.account_label,
        auth_data=encrypt_value(account.auth_data) if account.auth_data else None,
        account_name=account.account_name,
        is_enabled=True,
        connection_status="connected" # Assume connected if they supply truth bucket info, or ghost will update it later
    )
    db.add(new_account)
    await db.commit()
    return {"status": "success", "id": new_account.id}

@router.put("/{account_id}")
async def update_account(account_id: str, updates: AccountUpdate, db: AsyncSession = Depends(get_db), current_user = Depends(get_current_user)):
    stmt = _owner_scope(select(PlatformConnection).where(PlatformConnection.id == account_id), current_user)
    result = await db.execute(stmt)
    acc = result.scalar_one_or_none()
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")

    exclude = updates.model_dump(exclude_unset=True)
    for k, v in exclude.items():
        if k == "auth_data" and v:
            v = encrypt_value(v)
        setattr(acc, k, v)

    await db.commit()
    return {"status": "success"}

@router.delete("/{account_id}")
async def delete_account(account_id: str, db: AsyncSession = Depends(get_db), current_user = Depends(get_current_user)):
    stmt = _owner_scope(select(PlatformConnection).where(PlatformConnection.id == account_id), current_user)
    result = await db.execute(stmt)
    acc = result.scalar_one_or_none()
    if acc:
        await db.delete(acc)
        await db.commit()
    return {"status": "success"}
