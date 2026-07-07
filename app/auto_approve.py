import logging
import threading
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from database import AutoApproveRule, EncodeJob, MediaCandidate, MediaLibrary, engine
from encoder import run_encode_job
from settings import get_setting  # used for auto_approve_enabled check

logger = logging.getLogger(__name__)

_RESOLUTION_BUCKETS = [
    ("4k",    3840),
    ("1080p", 1920),
    ("720p",  1280),
    ("480p",     0),
]


def _recommend_quality(bitrate_kbps: int | None, source_codec: str | None = None) -> int:
    """Recommend a quality level (1–5) based on source bitrate and codec.

    For already-efficient sources (HEVC/H265/AV1) the only level that reliably
    shrinks the file is High Compress (2). NVENC HEVC at CQ 20 (Balanced) or
    CQ 16 (High Quality) targets a bitrate band that the source's existing
    efficient encoder was already operating in or below — re-encoding tends to
    preserve or exceed the source bitrate. Bitrate tiering doesn't help: an
    HEVC source at 8 Mbps was *encoded* at that target, so re-targeting near
    the same band rarely saves space. Only stepping up to CQ 24 reliably wins.

    For non-efficient codecs (h264, MPEG-2, MPEG-4, Xvid, DivX) there is large
    HEVC headroom at any bitrate, so tier by source bitrate to balance space
    saving vs. quality preservation on premium content.
    """
    if source_codec and source_codec.lower() in {"hevc", "h265", "av1"}:
        return 2
    if not bitrate_kbps:
        return 3
    if bitrate_kbps > 15000:
        return 4
    if bitrate_kbps > 5000:
        return 3
    if bitrate_kbps > 2000:
        return 2
    return 1


def _classify_resolution(width: int | None) -> str | None:
    if not width:
        return None
    for label, min_w in _RESOLUTION_BUCKETS:
        if width >= min_w:
            return label
    return "480p"


def _matches_rule(candidate: MediaCandidate, rule: AutoApproveRule) -> bool:
    if candidate.estimated_savings_percent is None or candidate.estimated_savings_percent <= 0:
        return False

    if rule.min_savings_percent is not None:
        if candidate.estimated_savings_percent < rule.min_savings_percent:
            return False

    if rule.source_codecs:
        allowed = {c.strip().lower() for c in rule.source_codecs.split(",")}
        if not candidate.current_codec or candidate.current_codec.lower() not in allowed:
            return False

    if rule.resolutions:
        allowed_res = {r.strip().lower() for r in rule.resolutions.split(",")}
        res = _classify_resolution(candidate.width)
        if res not in allowed_res:
            return False

    return True


def evaluate_auto_approve() -> dict:
    if get_setting("auto_approve_enabled", "false").lower() != "true":
        return {"approved": 0}

    approved = 0
    with Session(engine) as db:
        rules = db.query(AutoApproveRule).filter(AutoApproveRule.enabled == True).all()
        if not rules:
            return {"approved": 0}

        libraries = db.query(MediaLibrary).filter(MediaLibrary.enabled == True).all()
        enabled_paths = [lib.path for lib in libraries]
        library_paths = {lib.id: lib.path for lib in libraries}
        if not enabled_paths:
            return {"approved": 0}

        candidates = (
            db.query(MediaCandidate)
            .filter(
                MediaCandidate.status == "pending",
                MediaCandidate.is_encode_candidate == True,
            )
            .all()
        )
        # Restrict to files that fall under an enabled library path
        candidates = [
            c for c in candidates
            if any(c.file_path.startswith(p) for p in enabled_paths)
        ]

        default_use_hardware = get_setting("default_use_hardware", "false").lower() == "true"
        default_hardware_type = get_setting("default_hardware_type", "nvenc")
        job_ids = []
        for candidate in candidates:
            for rule in rules:
                if rule.library_id and not candidate.file_path.startswith(library_paths.get(rule.library_id, "\x00")):
                    continue
                if _matches_rule(candidate, rule):
                    use_hw = rule.use_hardware if rule.use_hardware is not None else default_use_hardware
                    job = EncodeJob(
                        candidate_id=candidate.id,
                        target_codec=rule.target_codec or "hevc",
                        use_hardware=use_hw,
                        hardware_type=default_hardware_type if use_hw else None,
                        quality_level=_recommend_quality(candidate.current_bitrate, candidate.current_codec) if not rule.quality_level else rule.quality_level,
                        resolution=rule.target_resolution or None,
                        output_mode=rule.output_mode or "replace",
                        rename_enabled=rule.rename_enabled,
                        rename_custom_text_enabled=rule.rename_custom_text_enabled,
                        rename_custom_text=rule.rename_custom_text,
                        rename_include_codec=rule.rename_include_codec,
                        rename_include_resolution=rule.rename_include_resolution,
                        rename_separator=rule.rename_separator,
                        status="queued",
                        original_size_bytes=candidate.file_size_bytes,
                        date_created=datetime.now(timezone.utc),
                    )
                    db.add(job)
                    candidate.status = "approved"
                    candidate.auto_approved_rule_id = rule.id
                    db.flush()
                    job_ids.append(job.id)
                    approved += 1
                    break  # OR across rules — first match wins

        db.commit()

    for job_id in job_ids:
        threading.Thread(target=run_encode_job, args=(job_id,), daemon=True).start()

    logger.info("Auto-approve evaluated: %d candidate(s) approved", approved)
    return {"approved": approved}
