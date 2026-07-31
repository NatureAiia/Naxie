"""
Digital Force Auth — JWT, password hashing, user dependency.
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

# Single-user local mode: no login, no per-request auth. Set once at startup
# (see main.py's lifespan) via set_local_user(); get_current_user() below just
# hands back this constant instead of validating a token.
_LOCAL_USER: Optional[dict] = None


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
    Single-user local mode: no token validation. Every request is the one
    local operator, seeded at startup via set_local_user().
    """
    if _LOCAL_USER is None:
        raise RuntimeError("Local user not seeded — ensure_default_user()/set_local_user() must run at startup")
    return _LOCAL_USER


def require_role(*roles: str):
    """Single-user local mode: no role gating, everyone is the local superadmin."""
    async def checker(user: dict = Depends(get_current_user)) -> dict:
        return user
    return checker
