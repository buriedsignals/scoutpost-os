"""
Token encryption for sensitive fields at rest.

PURPOSE: Encrypt CMS bearer tokens (and any future sensitive fields) before
storage, decrypt on retrieval. Uses Fernet symmetric encryption with a key
derived from SESSION_SECRET via PBKDF2.

DEPENDS ON: config (session_secret)
USED BY: adapters/supabase/user_storage.py (CMS token encrypt/decrypt)
"""
import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

# Cached Fernet instance (derived once per process)
_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    """Derive a Fernet key from SESSION_SECRET using PBKDF2."""
    global _fernet
    if _fernet is None:
        from app.config import get_settings
        secret = get_settings().session_secret
        # PBKDF2 with SHA-256, 100k iterations, 32-byte key
        key = hashlib.pbkdf2_hmac(
            "sha256",
            secret.encode("utf-8"),
            b"cojournalist-cms-token-salt",
            100_000,
        )
        # Fernet requires url-safe base64 encoded 32-byte key
        _fernet = Fernet(base64.urlsafe_b64encode(key))
    return _fernet


def encrypt_token(plaintext: str) -> str:
    """Encrypt a token string. Returns base64-encoded ciphertext."""
    if not plaintext:
        return ""
    return _get_fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_token(ciphertext: str) -> str:
    """Decrypt a token string. Returns plaintext or empty string on failure."""
    if not ciphertext:
        return ""
    try:
        return _get_fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except (InvalidToken, Exception) as e:
        # If decryption fails, the token may be stored in plaintext (pre-encryption)
        # Return as-is for backward compatibility
        logger.warning("Token decryption failed (may be pre-encryption plaintext): %s", type(e).__name__)
        return ciphertext
