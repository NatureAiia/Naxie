"""
NAXIONAI — Auth API (Phase 1: dormant until settings.require_auth is true)

Bootstrap rule: the first account to ever set a real password claims the
existing single-user seed row (created by database.ensure_default_user()) and
becomes active/superadmin — no new row, no re-owning migration needed, since
every Goal/PlatformConnection/MediaAsset/KnowledgeItem already points at that
same seed row's id. Every signup after that lands as `pending` until an
admin/superadmin approves it.
"""

import logging
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, User
from auth import (
    hash_password, verify_password, create_access_token,
    get_current_user, require_role, layer_of_role,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])


class SignupRequest(BaseModel):
    email: EmailStr
    password: str
    username: str
    full_name: Optional[str] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


def _token_for(user: User) -> dict:
    return {
        "access_token": create_access_token({"sub": user.id, "role": user.role}),
        "token_type": "bearer",
    }


def _user_out(user: User) -> dict:
    return {
        "id": user.id, "username": user.username, "email": user.email,
        "role": user.role, "layer": layer_of_role(user.role),
        "full_name": user.full_name, "status": user.status,
    }


@router.get("/state")
async def auth_state(db: AsyncSession = Depends(get_db)):
    """Whether the app has ever had a real (non-seed) login claimed."""
    claimed = (await db.execute(select(User).where(User.has_set_password == True))).scalars().first()  # noqa: E712
    return {"needs_bootstrap": claimed is None}


@router.post("/signup")
async def signup(body: SignupRequest, db: AsyncSession = Depends(get_db)):
    existing = (await db.execute(select(User).where(User.email == body.email))).scalars().first()
    if existing and existing.has_set_password:
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")

    claimed = (await db.execute(select(User).where(User.has_set_password == True))).scalars().first()  # noqa: E712
    needs_bootstrap = claimed is None

    if needs_bootstrap:
        # Claim the legacy seed row in place (same id — everything it already
        # owns stays owned) rather than inserting a new one.
        seed = (await db.execute(select(User).order_by(User.created_at.asc()))).scalars().first()
        if seed is None:
            seed = User(id=str(uuid.uuid4()))
            db.add(seed)
        seed.username = body.username
        seed.email = body.email
        seed.full_name = body.full_name or seed.full_name
        seed.hashed_password = hash_password(body.password)
        seed.role = "superadmin"
        seed.status = "active"
        seed.is_active = True
        seed.has_set_password = True
        await db.commit()
        await db.refresh(seed)
        logger.info("[auth] bootstrap claimed by %s — superadmin", seed.email)
        return {**_token_for(seed), "user": _user_out(seed)}

    # Bootstrap already done — this is a normal new signup, lands pending.
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    user = User(
        id=str(uuid.uuid4()),
        username=body.username,
        email=body.email,
        full_name=body.full_name,
        hashed_password=hash_password(body.password),
        role="staff",
        status="pending",
        is_active=True,
        has_set_password=True,
    )
    db.add(user)
    await db.commit()
    logger.info("[auth] new signup %s — pending approval", user.email)
    return {"status": "pending", "message": "Account created — awaiting admin approval."}


@router.post("/login")
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = (await db.execute(select(User).where(User.email == body.email))).scalars().first()
    if user is None or not user.has_set_password or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    if user.status == "pending":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account awaiting approval")
    if user.status != "active" or not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account disabled")
    return {**_token_for(user), "user": _user_out(user)}


@router.get("/me")
async def me(current_user: dict = Depends(get_current_user)):
    return current_user


@router.get("/pending", response_model=List[dict])
async def list_pending(
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_role("admin", "superadmin")),
):
    rows = (await db.execute(select(User).where(User.status == "pending"))).scalars().all()
    return [_user_out(u) for u in rows]


@router.post("/pending/{user_id}/approve")
async def approve_pending(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _: dict = Depends(require_role("admin", "superadmin")),
):
    user = (await db.execute(select(User).where(User.id == user_id))).scalars().first()
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    user.status = "active"
    await db.commit()
    return {"status": "active", "user": _user_out(user)}
