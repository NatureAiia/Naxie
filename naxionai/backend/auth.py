"""
NAXIONAI Auth — JWT, password hashing, user dependency.
"""

from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
import bcrypt
from datetime import datetime, timedelta
from typing import Optional
from config import get_settings

settings = get_settings()
bearer_scheme = HTTPBearer(auto_error=False)

# Single-user local mode (settings.require_auth == False, the default): no
# login, no per-request auth. Set once at startup (see main.py's lifespan)
# via set_local_user(); get_current_user() hands back this constant instead
# of validating a token. When require_auth is turned on, this is only used
# as a fallback if a request somehow reaches get_current_user with no
# token infrastructure available — real auth goes through api/auth.py.
_LOCAL_USER: Optional[dict] = None

# superadmin > admin > staff. Legacy `operator`/`viewer` role values (from
# before Phase 1) resolve to staff/admin equivalents so existing rows and
# call sites written against the old two-tier model keep working.
_ROLE_LAYER = {
    "superadmin": "superadmin",
    "admin": "admin",
    "staff": "staff",
    "operator": "staff",  # legacy column default — never actually admin (matches old _is_admin())
    "member": "staff",
    "viewer": "staff",
}


def layer_of_role(role: Optional[str]) -> str:
    """Collapse any known role value onto the three access layers."""
    return _ROLE_LAYER.get((role or "").lower(), "staff")


def set_local_user(payload: dict) -> None:
    global _LOCAL_USER
    _LOCAL_USER = payload


def hash_password(password: str) -> str:
    """Hash a password using bcrypt directly (avoids passlib/Python 3.14 compat issues)."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=settings.jwt_expiration_minutes))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    """Decode and validate a JWT token. Raises ValueError on failure."""
    try:
        return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError as e:
        raise ValueError(f"Invalid token: {e}")


async def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> dict:
    """
    settings.require_auth == False (default): single-user local mode, no
    token validation — every request is the one local user, seeded at
    startup via set_local_user(). This is what makes the whole Phase 1
    migration safe to ship dormant: nothing below this branch runs until
    the flag is explicitly turned on.

    settings.require_auth == True: real bearer-token validation against the
    users table.
    """
    if not settings.require_auth:
        if _LOCAL_USER is None:
            raise RuntimeError("Local user not seeded — ensure_default_user()/set_local_user() must run at startup")
        return _LOCAL_USER

    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = decode_token(credentials.credentials)
    except ValueError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")

    from sqlalchemy import select
    from database import async_session, User

    async with async_session() as db:
        user = (await db.execute(select(User).where(User.id == payload.get("sub")))).scalars().first()

    if user is None or not user.is_active or user.status != "active":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account not active")

    return {
        "sub": user.id,
        "username": user.username,
        "role": user.role,
        "email": user.email,
        "full_name": user.full_name,
    }


def require_role(*roles: str):
    """Gate a route to one or more access layers (see layer_of_role()).
    `roles` are layer names ("staff", "admin", "superadmin"), not raw DB role
    strings. No-op (any authenticated user passes) while require_auth is off."""
    async def checker(user: dict = Depends(get_current_user)) -> dict:
        if settings.require_auth and layer_of_role(user.get("role")) not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient access")
        return user
    return checker
