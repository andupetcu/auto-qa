"""HMAC-signed artifact URLs."""
import hashlib
import hmac
import time
from urllib.parse import quote

from app.settings import Settings

DEFAULT_TTL_S = 7 * 24 * 3600


def _sig(secret: str, storage_key: str, exp: int) -> str:
    message = f"{storage_key}:{exp}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def signed_url_for(
    settings: Settings,
    storage_key: str,
    expires_at: int | None = None,
    ttl_s: int = DEFAULT_TTL_S,
) -> str:
    exp = expires_at if expires_at is not None else int(time.time()) + ttl_s
    sig = _sig(settings.signing_secret, storage_key, exp)
    return f"/artifacts/{quote(storage_key)}?exp={exp}&sig={sig}"


def verify_signature(settings: Settings, storage_key: str, exp: int, sig: str) -> bool:
    expected = _sig(settings.signing_secret, storage_key, exp)
    return hmac.compare_digest(expected, sig)
