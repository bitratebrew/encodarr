import logging

logger = logging.getLogger(__name__)

SESSION_COOKIE = "encodarr_session"


def _secret_key() -> str:
    from settings import get_setting
    return get_setting("secret_key") or "fallback-no-key-set"


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
    return URLSafeSerializer(_secret_key()).dumps("ok")


def verify_session_token(token: str) -> bool:
    from itsdangerous import URLSafeSerializer, BadSignature
    try:
        return URLSafeSerializer(_secret_key()).loads(token) == "ok"
    except BadSignature:
        return False
