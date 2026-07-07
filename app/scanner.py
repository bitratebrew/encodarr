import json
import logging
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from database import MediaCandidate, MediaLibrary, engine

logger = logging.getLogger(__name__)

MEDIA_PATH = os.environ.get("MEDIA_PATH", "/media")
VIDEO_EXTENSIONS = {".mkv", ".mp4", ".avi", ".mov", ".m4v", ".ts"}
BITRATE_THRESHOLD_KBPS = 8000
ALREADY_EFFICIENT_CODECS = {"hevc", "h265", "av1"}

SAVINGS_BY_CODEC = {
    "h264": 40.0,
    "mpeg2video": 60.0,
    "mpeg4": 60.0,
    "xvid": 60.0,
    "divx": 60.0,
    # Already-efficient codecs over the bitrate threshold: conservative estimate
    # because re-encoding same→same codec yields far less saving than h264→hevc.
    "hevc": 15.0,
    "h265": 15.0,
    "av1":  10.0,
}


def _run_ffprobe(file_path: str) -> dict | None:
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        file_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            logger.warning("ffprobe failed for %s: %s", file_path, result.stderr.strip())
            return None
        return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as exc:
        logger.warning("ffprobe error for %s: %s", file_path, exc)
        return None


def _parse_probe(probe: dict) -> dict | None:
    video_stream = next(
        (s for s in probe.get("streams", []) if s.get("codec_type") == "video"),
        None,
    )
    if not video_stream:
        return None

    fmt = probe.get("format", {})

    codec = video_stream.get("codec_name", "").lower()

    raw_bitrate = fmt.get("bit_rate") or video_stream.get("bit_rate")
    try:
        bitrate_kbps = int(raw_bitrate) // 1000 if raw_bitrate else 0
    except (ValueError, TypeError):
        bitrate_kbps = 0

    try:
        duration = float(fmt.get("duration") or video_stream.get("duration") or 0)
    except (ValueError, TypeError):
        duration = 0.0

    try:
        width = int(video_stream.get("width") or 0) or None
        height = int(video_stream.get("height") or 0) or None
    except (ValueError, TypeError):
        width = height = None

    return {
        "codec": codec,
        "bitrate_kbps": bitrate_kbps,
        "duration": duration,
        "width": width,
        "height": height,
    }


def _is_candidate(codec: str, bitrate_kbps: int) -> bool:
    if codec not in ALREADY_EFFICIENT_CODECS:
        return True
    if bitrate_kbps > BITRATE_THRESHOLD_KBPS:
        return True
    return False


def _estimate_savings(codec: str) -> float:
    return SAVINGS_BY_CODEC.get(codec, 30.0)


def _upsert_candidate(db: Session, file_path: str, file_size: int, info: dict) -> bool:
    existing = db.query(MediaCandidate).filter_by(file_path=file_path).first()
    if existing:
        return False

    is_candidate = _is_candidate(info["codec"], info["bitrate_kbps"])
    candidate = MediaCandidate(
        file_path=file_path,
        file_size_bytes=file_size,
        duration_seconds=info["duration"],
        current_codec=info["codec"],
        current_bitrate=info["bitrate_kbps"],
        estimated_savings_percent=_estimate_savings(info["codec"]) if is_candidate else None,
        width=info.get("width"),
        height=info.get("height"),
        is_encode_candidate=is_candidate,
        status="pending",
        date_discovered=datetime.now(timezone.utc),
        date_updated=datetime.now(timezone.utc),
    )
    db.add(candidate)
    return True


def _candidate_is_under_paths(candidate_path: str, library_paths: list[str]) -> bool:
    for library_path in library_paths:
        root = library_path.rstrip(os.sep)
        if candidate_path == root or candidate_path.startswith(root + os.sep):
            return True
    return False


def scan_library(library_id: int | None = None) -> dict:
    with Session(engine) as db:
        q = db.query(MediaLibrary).filter(MediaLibrary.enabled == True)
        if library_id is not None:
            q = q.filter(MediaLibrary.id == library_id)
        libraries = q.all()
        library_paths = [lib.path for lib in libraries]

    if not library_paths:
        logger.warning("No media libraries configured — skipping scan")
        return {"scanned": 0, "added": 0, "errors": 0, "missing": 0, "skipped": "no libraries configured"}

    files: list[Path] = []
    for lib_path in library_paths:
        root = Path(lib_path)
        if not root.exists():
            logger.warning("Library path does not exist, skipping: %s", root)
            continue
        lib_files = [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS]
        logger.info("Found %d video file(s) under %s", len(lib_files), root)
        files.extend(lib_files)

    scanned = added = errors = missing = 0

    with Session(engine) as db:
        active_candidates = (
            db.query(MediaCandidate)
            .filter(MediaCandidate.status.notin_(["complete", "skipped"]))
            .all()
        )
        for candidate in active_candidates:
            if not _candidate_is_under_paths(candidate.file_path, library_paths):
                continue
            if not os.path.exists(candidate.file_path):
                logger.warning("Candidate file no longer exists, marking missing: %s", candidate.file_path)
                candidate.status = "missing"
                missing += 1
        if missing:
            db.commit()
            logger.info("Marked %d candidate(s) as missing", missing)

        for path in files:
            file_path = str(path)
            scanned += 1
            logger.debug("Probing %s", file_path)

            probe = _run_ffprobe(file_path)
            if probe is None:
                errors += 1
                continue

            info = _parse_probe(probe)
            if info is None:
                logger.debug("No video stream found in %s, skipping", file_path)
                continue

            try:
                file_size = os.path.getsize(file_path)
            except OSError as exc:
                logger.warning("Could not stat %s: %s", file_path, exc)
                errors += 1
                continue

            if _upsert_candidate(db, file_path, file_size, info):
                added += 1
                logger.info("New file: %s (%s, %d kbps, encode_candidate=%s)", file_path, info["codec"], info["bitrate_kbps"], _is_candidate(info["codec"], info["bitrate_kbps"]))

        db.commit()

    logger.info("Scan complete — scanned=%d added=%d errors=%d missing=%d", scanned, added, errors, missing)
    return {"scanned": scanned, "added": added, "errors": errors, "missing": missing}


def get_scan_status() -> dict:
    with Session(engine) as db:
        total = db.query(MediaCandidate).count()
        encode_candidates = db.query(MediaCandidate).filter(MediaCandidate.is_encode_candidate == True, MediaCandidate.status.notin_(["complete", "skipped"])).count()
        pending = db.query(MediaCandidate).filter(MediaCandidate.status == "pending", MediaCandidate.is_encode_candidate == True).count()
        missing = db.query(MediaCandidate).filter(MediaCandidate.status == "missing").count()
        libraries_configured = db.query(MediaLibrary).filter(MediaLibrary.enabled == True).count()
    return {"total": total, "encode_candidates": encode_candidates, "pending": pending, "missing": missing, "libraries_configured": libraries_configured}
