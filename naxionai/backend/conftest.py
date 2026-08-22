"""
Shared pytest fixtures for naxionai/backend.

IMPORTANT: env vars below must be set before ANY of config.py/database.py/
auth.py is imported (by this file or any test module), because:
  - config.get_settings() is @lru_cache'd — the first call wins for the
    whole process.
  - database.py builds its `engine`/`async_session` at *module import time*
    from settings.database_url (database.py:747-753) — there is no factory
    to call later with a different URL.
  - auth.py captures `settings = get_settings()` as a module-level global
    at import time (auth.py:13) — create_access_token/decode_token/
    require_role all close over that same instance.
pytest always imports conftest.py before collecting/importing test modules
in the same directory, so setting os.environ here — before any `import
config`/`import database`/`import auth` anywhere in this file — is safe.
"""

import os
import tempfile

_TMP_DB_FD, _TMP_DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_TMP_DB_FD)

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_TMP_DB_PATH}")
os.environ.setdefault("ENCRYPTION_KEY", "test-only-encryption-key-32-bytes")
os.environ.setdefault("JWT_SECRET_KEY", "test-only-jwt-secret-key")
os.environ.setdefault("REQUIRE_AUTH", "false")

import asyncio
import pytest

import database
import auth


@pytest.fixture(scope="session", autouse=True)
def _init_test_db():
    """Create every table once in the temp sqlite file, then remove it when
    the whole test session ends. Session-scoped and autouse: individual
    test modules that don't touch the DB at all (governance/encryption/
    connector/data-source/rag SSRF tests) pay nothing extra, but anything
    that does hit `database.async_session` gets real tables without each
    test file needing to remember to call init_db() itself."""
    asyncio.run(database.init_db())
    yield
    try:
        os.remove(_TMP_DB_PATH)
    except OSError:
        pass


@pytest.fixture
def local_user():
    """Seed the single-user local-mode identity that get_current_user()
    (auth.py:89-92) requires — without this, any code path touching
    get_current_user() in the default require_auth=False mode raises
    RuntimeError("Local user not seeded")."""
    payload = {"sub": "test-user-id", "username": "test", "role": "admin", "email": "test@example.com", "full_name": "Test User"}
    auth.set_local_user(payload)
    yield payload
    auth.set_local_user(None)
