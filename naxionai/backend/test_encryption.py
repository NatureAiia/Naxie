"""Tests for encryption.py (encryption.py:1-32) — Fernet-based symmetric
encryption for stored connector/credential secrets."""

import encryption as enc


def test_round_trip():
    plain = "sk-super-secret-api-key-12345"
    ciphertext = enc.encrypt_value(plain)
    assert ciphertext != plain
    assert enc.decrypt_value(ciphertext) == plain


def test_empty_string_short_circuits_without_becoming_a_fernet_token():
    assert enc.encrypt_value("") == ""
    assert enc.decrypt_value("") == ""


def test_different_plaintexts_produce_different_ciphertexts():
    a = enc.encrypt_value("value-a")
    b = enc.encrypt_value("value-b")
    assert a != b


def test_ciphertext_is_not_decryptable_with_a_different_key(monkeypatch):
    ciphertext = enc.encrypt_value("some secret")

    from config import get_settings
    get_settings.cache_clear()
    monkeypatch.setenv("ENCRYPTION_KEY", "a-completely-different-key-value")
    get_settings.cache_clear()
    try:
        import cryptography.fernet
        try:
            enc.decrypt_value(ciphertext)
            assert False, "decrypting with a different key should fail"
        except cryptography.fernet.InvalidToken:
            pass
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
