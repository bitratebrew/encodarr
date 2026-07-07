import logging

logger = logging.getLogger(__name__)

SESSION_COOKIE = "encodarr_session"


def _secret_key() -> str | None:
    from settings import get_setting
    # Return None (not a constant) when unset. A guessable constant fallback would
    # let anyone forge a valid session cookie, so callers must handle None safely.
    return get_setting("secret_key") or None


def _ensure_secret_key() -> str:
    from settings import get_setting, init_secret_key
    key = get_setting("secret_key")
    if not key:
        # Startup normally seeds this; regenerate if it was never set or was wiped
        # (e.g. by reset-all). Minting a fresh key invalidates old cookies, which
        # is the safe outcome.
        init_secret_key()
        key = get_setting("secret_key")
    return key


def hash_password(password: str) -> str:
    import bcrypt
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    import bcrypt
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


def make_session_token() -> str:
    from itsdangerous import URLSafeSerializer
    return URLSafeSerializer(_ensure_secret_key()).dumps("ok")


def verify_session_token(token: str) -> bool:
    from itsdangerous import URLSafeSerializer, BadSignature
    key = _secret_key()
    if not key:
        # No signing key configured — deny rather than fall back to a constant.
        return False
    try:
        return URLSafeSerializer(key).loads(token) == "ok"
    except BadSignature:
        return False
