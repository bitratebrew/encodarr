import logging
import os
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Session, relationship

DATA_PATH = os.environ.get("DATA_PATH", "/data")
DATABASE_URL = f"sqlite:///{DATA_PATH}/encodarr.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


class Base(DeclarativeBase):
    pass


class AutoApproveRule(Base):
    __tablename__ = "auto_approve_rules"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    enabled = Column(Boolean, default=True)
    min_savings_percent = Column(Float, nullable=True)
    resolutions = Column(String, nullable=True)    # comma-sep: "4k,1080p,720p,480p" — null = any
    source_codecs = Column(String, nullable=True)  # comma-sep: "h264,mpeg2video" — null = any
    target_codec = Column(String, default="hevc")  # hevc | av1
    target_resolution = Column(String, nullable=True)  # null = keep original | "4k" | "1080p" | "720p" | "480p"
    output_mode = Column(String, default="replace")    # replace | copy
    quality_level = Column(Integer, default=3)         # 0=Auto, 1–5 matching approve modal
    use_hardware = Column(Boolean, nullable=True)           # null = inherit from default_use_hardware
    rename_enabled = Column(Boolean, nullable=True)         # null = inherit from rename_copy/replace_enabled
    rename_custom_text_enabled = Column(Boolean, nullable=True)
    rename_custom_text = Column(String, nullable=True)      # null = inherit
    rename_include_codec = Column(Boolean, nullable=True)
    rename_include_resolution = Column(Boolean, nullable=True)
    rename_separator = Column(String, nullable=True)        # null = inherit
    library_id = Column(Integer, ForeignKey("media_libraries.id"), nullable=True)  # null = all libraries
    date_created = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class MediaCandidate(Base):
    __tablename__ = "media_candidates"

    id = Column(Integer, primary_key=True)
    file_path = Column(String, unique=True, nullable=False)
    file_size_bytes = Column(Integer)
    duration_seconds = Column(Float)
    current_codec = Column(String)
    current_bitrate = Column(Integer)
    estimated_savings_percent = Column(Float)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    auto_approved_rule_id = Column(Integer, ForeignKey("auto_approve_rules.id"), nullable=True)
    is_encode_candidate = Column(Boolean, default=False)
    status = Column(String, default="pending")  # pending|approved|encoding|complete|failed|skipped|missing
    date_discovered = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    date_updated = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    jobs = relationship("EncodeJob", back_populates="candidate")


class EncodeJob(Base):
    __tablename__ = "encode_jobs"

    id = Column(Integer, primary_key=True)
    candidate_id = Column(Integer, ForeignKey("media_candidates.id"), nullable=False)
    target_codec = Column(String, nullable=False)  # hevc|av1
    use_hardware = Column(Boolean, default=False)
    hardware_type = Column(String, nullable=True)  # nvenc|vaapi|videotoolbox
    status = Column(String, default="queued")  # queued|encoding|complete|failed|ignored
    error_message = Column(String, nullable=True)
    quality_level = Column(Integer, default=3)
    resolution = Column(String, nullable=True)
    output_mode = Column(String, default="replace")
    rename_enabled = Column(Boolean, nullable=True)
    rename_custom_text_enabled = Column(Boolean, nullable=True)
    rename_custom_text = Column(String, nullable=True)
    rename_include_codec = Column(Boolean, nullable=True)
    rename_include_resolution = Column(Boolean, nullable=True)
    rename_separator = Column(String, nullable=True)
    original_size_bytes = Column(Integer)
    final_size_bytes = Column(Integer, nullable=True)
    date_created = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    date_completed = Column(DateTime, nullable=True)

    candidate = relationship("MediaCandidate", back_populates="jobs")


class AppSetting(Base):
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True)
    key = Column(String, unique=True, nullable=False)
    value = Column(String, nullable=True)
    description = Column(String, nullable=True)
    date_updated = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class ScheduledGovernor(Base):
    __tablename__ = "scheduled_governors"

    id = Column(Integer, primary_key=True)
    label = Column(String, nullable=True)
    start_time = Column(String, nullable=False)   # "HH:MM"
    end_time = Column(String, nullable=False)      # "HH:MM"
    cpu_limit = Column(Integer, nullable=False)
    gpu_limit = Column(Integer, nullable=False)
    max_concurrent = Column(Integer, nullable=False)
    enabled = Column(Boolean, default=True)
    date_created = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class MediaLibrary(Base):
    __tablename__ = "media_libraries"

    id = Column(Integer, primary_key=True)
    path = Column(String, unique=True, nullable=False)
    label = Column(String, nullable=True)
    enabled = Column(Boolean, default=True)
    scan_on_startup = Column(Boolean, default=False)
    date_added = Column(DateTime, default=lambda: datetime.now(timezone.utc))


def get_db():
    db = Session(engine)
    try:
        yield db
    finally:
        db.close()


_MIGRATIONS = {
    "media_candidates": [
        ("is_encode_candidate",    "BOOLEAN", "DEFAULT 0"),
        ("width",                  "INTEGER", ""),
        ("height",                 "INTEGER", ""),
        ("auto_approved_rule_id",  "INTEGER", ""),
    ],
    "auto_approve_rules": [
        ("target_codec",             "TEXT",    "DEFAULT 'hevc'"),
        ("target_resolution",        "TEXT",    ""),
        ("output_mode",              "TEXT",    "DEFAULT 'replace'"),
        ("quality_level",            "INTEGER", "DEFAULT 3"),
        ("use_hardware",             "BOOLEAN", ""),
        ("rename_enabled",           "BOOLEAN", ""),
        ("rename_custom_text_enabled","BOOLEAN",""),
        ("rename_custom_text",       "TEXT",    ""),
        ("rename_include_codec",     "BOOLEAN", ""),
        ("rename_include_resolution","BOOLEAN", ""),
        ("rename_separator",         "TEXT",    ""),
        ("library_id",               "INTEGER", ""),
    ],
    "encode_jobs": [
        ("error_message",            "TEXT",    ""),
        ("quality_level",            "INTEGER", "DEFAULT 3"),
        ("resolution",               "TEXT",    ""),
        ("output_mode",              "TEXT",    "DEFAULT 'replace'"),
        ("rename_enabled",           "BOOLEAN", ""),
        ("rename_custom_text_enabled","BOOLEAN",""),
        ("rename_custom_text",       "TEXT",    ""),
        ("rename_include_codec",     "BOOLEAN", ""),
        ("rename_include_resolution","BOOLEAN", ""),
        ("rename_separator",         "TEXT",    ""),
    ],
    "app_settings": [
        ("description", "TEXT", ""),
        ("date_updated", "TEXT", ""),
    ],
    "media_libraries": [
        ("label",           "TEXT",    ""),
        ("enabled",         "BOOLEAN", "DEFAULT 1"),
        ("scan_on_startup", "BOOLEAN", "DEFAULT 0"),
        ("date_added",      "TEXT",    ""),
    ],
}


def migrate_db() -> None:
    with engine.connect() as conn:
        raw = conn.connection
        cursor = raw.cursor()
        for table, columns in _MIGRATIONS.items():
            cursor.execute(f"PRAGMA table_info({table})")
            existing = {row[1] for row in cursor.fetchall()}
            for col, col_type, default in columns:
                if col not in existing:
                    clause = f"ALTER TABLE {table} ADD COLUMN {col} {col_type}"
                    if default:
                        clause += f" {default}"
                    cursor.execute(clause)
                    logger.info("migrate_db: added column %s.%s", table, col)
        raw.commit()


def init_db():
    Base.metadata.create_all(bind=engine)
    migrate_db()
