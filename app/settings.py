import logging
import secrets
from datetime import datetime, timezone

from database import AppSetting, Session, engine

logger = logging.getLogger(__name__)

_DEFAULTS = {
    "encode_cpu_limit_percent": ("80",  "CPU usage limit for software encoding (percent)"),
    "max_concurrent_encodes":   ("1",   "Maximum number of simultaneous encode jobs"),
    "default_codec":            ("hevc",  "Default target codec for new jobs"),
    "default_quality_level":    ("3",    "Default quality level: 0=Auto, 1–5 fixed"),
    "default_output_mode":      ("copy", "Default output mode: replace or copy"),
    "default_use_hardware":     ("false", "Default: use hardware encoding when available"),
    "default_hardware_type":    ("nvenc", "Default hardware encoder type"),
    "default_resolution":       ("",     "Default output resolution (empty = keep original)"),
    "scan_schedule_enabled":        ("false", "Enable scheduled library scans"),
    "scan_schedule_interval_hours": ("24",   "Interval in hours between scheduled scans"),
    "auto_approve_enabled":         ("false", "Enable auto-approve rules engine"),
    "scheduled_windows_enabled":    ("false", "Enable scheduled resource governor windows"),
    "notifications_enabled":        ("false", "Enable Apprise notifications"),
    "apprise_urls":                 ("",      "Apprise service URLs, one per line"),
    "rename_copy_enabled":           ("true",  "Rename output file when output mode is copy"),
    "rename_replace_enabled":        ("false", "Rename output file when output mode is replace"),
    "rename_custom_text_enabled":    ("true",  "Include custom text in renamed filename"),
    "rename_custom_text":            ("encodarr", "Custom text to append to renamed filename"),
    "rename_include_codec":          ("false", "Append target codec to renamed filename"),
    "rename_include_resolution":     ("false", "Append output resolution to renamed filename (only if downscale applied)"),
    "rename_separator":              ("_",     "Separator between filename components: _ . -"),
    "auth_username":                 ("",      "UI login username; empty = auth disabled"),
    "auth_password_hash":           ("",      "Bcrypt hash of the UI password; empty = auth disabled"),
    "secret_key":                   ("",      "Signing key for session tokens; generated on first startup"),
}


def seed_default_settings() -> None:
    with Session(engine) as db:
        for key, (value, description) in _DEFAULTS.items():
            exists = db.query(AppSetting).filter_by(key=key).first()
            if not exists:
                db.add(AppSetting(
                    key=key,
                    value=value,
                    description=description,
                    date_updated=datetime.now(timezone.utc),
                ))
                logger.info("Seeded default setting: %s = %s", key, value)
        db.commit()


def get_setting(key: str, default=None) -> str | None:
    with Session(engine) as db:
        row = db.query(AppSetting).filter_by(key=key).first()
        return row.value if row else default


def set_setting(key: str, value: str) -> None:
    with Session(engine) as db:
        row = db.query(AppSetting).filter_by(key=key).first()
        if row:
            row.value = value
            row.date_updated = datetime.now(timezone.utc)
        else:
            db.add(AppSetting(key=key, value=value, date_updated=datetime.now(timezone.utc)))
        db.commit()


def init_secret_key() -> None:
    """Generate and persist a secret key if one doesn't exist yet."""
    existing = get_setting("secret_key")
    if not existing:
        set_setting("secret_key", secrets.token_hex(32))
        logger.info("Generated new session secret key")


def get_all_settings() -> dict:
    with Session(engine) as db:
        rows = db.query(AppSetting).all()
        return {row.key: row.value for row in rows}


_governor_overrides: dict = {}


def get_effective_setting(key: str, default=None) -> str | None:
    """Return governor window override if active, otherwise DB value."""
    if key in _governor_overrides:
        return str(_governor_overrides[key])
    return get_setting(key, default)


def set_governor_overrides(overrides: dict) -> None:
    global _governor_overrides
    _governor_overrides = dict(overrides)
    logger.info("Governor overrides applied: %s", overrides)


def clear_governor_overrides() -> None:
    global _governor_overrides
    _governor_overrides = {}
    logger.info("Governor overrides cleared")


def get_governor_active() -> bool:
    return bool(_governor_overrides)


def get_governor_overrides() -> dict:
    return dict(_governor_overrides)
