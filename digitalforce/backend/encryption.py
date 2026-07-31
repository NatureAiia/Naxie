"""
Digital Force — Symmetric encryption for stored credentials.
Used to encrypt PlatformConnection.auth_data and other secret-bearing
fields before they hit the database.
"""

import base64
import hashlib

from cryptography.fernet import Fernet

from config import get_settings


def _get_cipher() -> Fernet:
    settings = get_settings()
    key = hashlib.sha256(settings.encryption_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_value(value: str) -> str:
    """Encrypt a string value. Empty input returns empty output."""
    if not value:
        return ""
    return _get_cipher().encrypt(value.encode()).decode()


def decrypt_value(encrypted_value: str) -> str:
    """Decrypt an encrypted string value. Empty input returns empty output."""
    if not encrypted_value:
        return ""
    return _get_cipher().decrypt(encrypted_value.encode()).decode()
