"""Tests for auth.py (auth.py:1-128) — password hashing, JWT, role gating.

Note (auth.py:13): `settings = get_settings()` is captured as a module-level
global at import time, so create_access_token/decode_token/require_role all
close over that SAME Settings instance for the life of the process — tests
that need a different jwt_secret_key/require_auth value must mutate
`auth.settings` directly rather than only patching env vars/get_settings().
"""

import time
from datetime import timedelta

import pytest
from fastapi import HTTPException

import auth


def test_hash_and_verify_round_trip():
    hashed = auth.hash_password("correct-horse-battery-staple")
    assert hashed != "correct-horse-battery-staple"
    assert auth.verify_password("correct-horse-battery-staple", hashed)


def test_verify_rejects_wrong_password():
    hashed = auth.hash_password("correct-horse-battery-staple")
    assert not auth.verify_password("wrong-password", hashed)


def test_verify_fails_closed_on_garbage_hash():
    # bcrypt.checkpw raises ValueError on a malformed hash — verify_password
    # must swallow it and return False, never raise (auth.py:52-57).
    assert auth.verify_password("anything", "not-a-real-bcrypt-hash") is False


def test_create_and_decode_token_round_trip():
    token = auth.create_access_token({"sub": "user-123"})
    payload = auth.decode_token(token)
    assert payload["sub"] == "user-123"
    assert "exp" in payload


def test_decode_rejects_tampered_token():
    token = auth.create_access_token({"sub": "user-123"})
    tampered = token[:-4] + ("0" * 4 if token[-4:] != "0000" else "1111")
    with pytest.raises(ValueError):
        auth.decode_token(tampered)


def test_decode_rejects_expired_token():
    token = auth.create_access_token({"sub": "user-123"}, expires_delta=timedelta(seconds=-1))
    with pytest.raises(ValueError):
        auth.decode_token(token)


def test_layer_of_role_collapses_legacy_roles():
    assert auth.layer_of_role("superadmin") == "superadmin"
    assert auth.layer_of_role("admin") == "admin"
    assert auth.layer_of_role("operator") == "staff"  # legacy default, auth.py:31
    assert auth.layer_of_role("member") == "staff"
    assert auth.layer_of_role("viewer") == "staff"
    assert auth.layer_of_role(None) == "staff"
    assert auth.layer_of_role("something-unknown") == "staff"


@pytest.mark.asyncio
async def test_get_current_user_returns_local_user_when_auth_off(local_user):
    # require_auth defaults to False (config.py:40) via conftest's env setup.
    user = await auth.get_current_user(request=None, credentials=None)
    assert user == local_user


@pytest.mark.asyncio
async def test_get_current_user_raises_if_local_user_never_seeded():
    auth.set_local_user(None)
    with pytest.raises(RuntimeError):
        await auth.get_current_user(request=None, credentials=None)


@pytest.mark.asyncio
async def test_require_role_is_a_no_op_when_require_auth_is_off(local_user, monkeypatch):
    monkeypatch.setattr(auth.settings, "require_auth", False)
    checker = auth.require_role("superadmin")  # local_user's role is "admin"
    user = await checker(user=local_user)
    assert user == local_user  # not rejected, even though role doesn't match


@pytest.mark.asyncio
async def test_require_role_rejects_insufficient_layer_when_enforced(local_user, monkeypatch):
    monkeypatch.setattr(auth.settings, "require_auth", True)
    checker = auth.require_role("superadmin")  # local_user's role is "admin"
    with pytest.raises(HTTPException) as exc_info:
        await checker(user=local_user)
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_require_role_passes_when_layer_matches_and_enforced(local_user, monkeypatch):
    monkeypatch.setattr(auth.settings, "require_auth", True)
    checker = auth.require_role("admin", "superadmin")
    user = await checker(user=local_user)
    assert user == local_user
