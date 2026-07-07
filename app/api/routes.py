# Defines all HTTP API routes exposed by the service.
# Provides endpoints for triggering scans, managing the encoding queue,
# retrieving job status, and adjusting configuration at runtime.

import os
from datetime import datetime, timezone
from pathlib import Path as FSPath
from typing import Optional

import psutil

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from auto_approve import evaluate_auto_approve
from database import AppSetting, AutoApproveRule, EncodeJob, MediaCandidate, MediaLibrary, ScheduledGovernor, get_db
from encoder import _available_hardware, _sem_released as _encoder_sem_released, cancel_job as kill_encode_process, dispatch_queued_jobs, get_job_progress, get_queue_status, pause_job, reset_encode_semaphore, resume_job, run_encode_job
from scanner import get_scan_status, scan_library
from scheduler import get_scheduled_scan_info
from auth import SESSION_COOKIE, hash_password, make_session_token, verify_password
from settings import get_all_settings, get_governor_active, get_governor_overrides, get_setting, set_setting

router = APIRouter(prefix="/api")

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@router.get("/auth/status")
def auth_status():
    return {"enabled": bool(get_setting("auth_password_hash"))}


@router.post("/auth/login")
def auth_login(username: str = Form(...), password: str = Form(...)):
    stored_hash = get_setting("auth_password_hash")
    stored_username = get_setting("auth_username") or ""
    if (not stored_hash
            or username != stored_username
            or not verify_password(password, stored_hash)):
        return RedirectResponse("/login?error=1", status_code=303)
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        SESSION_COOKIE,
        make_session_token(),
        max_age=86400 * 30,
        httponly=True,
        samesite="lax",
    )
    return response


@router.post("/auth/logout")
def auth_logout():
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.post("/auth/set-credentials")
def auth_set_credentials(body: dict):
    username = body.get("username", "").strip()
    password = body.get("password", "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    if len(password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    set_setting("auth_username", username)
    set_setting("auth_password_hash", hash_password(password))
    return {"ok": True}


@router.post("/auth/clear-password")
def auth_clear_password():
    set_setting("auth_password_hash", "")
    set_setting("auth_username", "")
    return {"ok": True}


class ApproveRequest(BaseModel):
    target_codec: str  # hevc | av1
    use_hardware: bool = False
    hardware_type: Optional[str] = None  # nvenc | vaapi | videotoolbox | None
    quality_level: int = 3
    resolution: Optional[str] = None
    output_mode: str = "replace"


class LibraryRequest(BaseModel):
    path: str
    label: Optional[str] = None


class LibraryUpdateRequest(BaseModel):
    label: Optional[str] = None
    enabled: Optional[bool] = None


class AutoApproveRuleRequest(BaseModel):
    name: str
    enabled: bool = True
    min_savings_percent: Optional[float] = None
    resolutions: Optional[str] = None    # comma-sep "4k,1080p" or null = any
    source_codecs: Optional[str] = None  # comma-sep "h264,mpeg2video" or null = any
    target_codec: str = "hevc"
    target_resolution: Optional[str] = None  # null = keep original
    output_mode: str = "replace"
    quality_level: int = 0
    use_hardware: Optional[bool] = None
    rename_enabled: Optional[bool] = None
    rename_custom_text_enabled: Optional[bool] = None
    rename_custom_text: Optional[str] = None
    rename_include_codec: Optional[bool] = None
    rename_include_resolution: Optional[bool] = None
    rename_separator: Optional[str] = None
    library_id: Optional[int] = None


class AutoApproveRuleUpdateRequest(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    min_savings_percent: Optional[float] = None
    resolutions: Optional[str] = None
    source_codecs: Optional[str] = None
    target_codec: Optional[str] = None
    target_resolution: Optional[str] = None
    output_mode: Optional[str] = None
    quality_level: Optional[int] = None
    use_hardware: Optional[bool] = None
    rename_enabled: Optional[bool] = None
    rename_custom_text_enabled: Optional[bool] = None
    rename_custom_text: Optional[str] = None
    rename_include_codec: Optional[bool] = None
    rename_include_resolution: Optional[bool] = None
    rename_separator: Optional[str] = None
    library_id: Optional[int] = None


class GovernorWindowRequest(BaseModel):
    label: Optional[str] = None
    start_time: str
    end_time: str
    cpu_limit: int
    max_concurrent: int
    enabled: bool = True


# ---------------------------------------------------------------------------
# Candidates
# ---------------------------------------------------------------------------

_CANDIDATE_SORT = {
    "file_path":                  MediaCandidate.file_path,
    "current_codec":              MediaCandidate.current_codec,
    "current_bitrate":            MediaCandidate.current_bitrate,
    "file_size_bytes":            MediaCandidate.file_size_bytes,
    "estimated_savings_percent":  MediaCandidate.estimated_savings_percent,
    "status":                     MediaCandidate.status,
    "date_discovered":            MediaCandidate.date_discovered,
}

_TERMINAL_CANDIDATE_STATUSES = ["complete", "skipped"]

@router.get("/candidates")
def list_candidates(
    status: Optional[str] = None,
    encode_candidates_only: bool = True,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    sort_by: str = "date_discovered",
    sort_order: str = "desc",
    db: Session = Depends(get_db),
):
    q = db.query(MediaCandidate)
    if status:
        q = q.filter(MediaCandidate.status == status)
    else:
        q = q.filter(MediaCandidate.status.notin_(_TERMINAL_CANDIDATE_STATUSES))
    if encode_candidates_only:
        q = q.filter(MediaCandidate.is_encode_candidate == True)
    if search:
        q = q.filter(MediaCandidate.file_path.ilike(f"%{search}%"))
    total = q.count()
    col = _CANDIDATE_SORT.get(sort_by, MediaCandidate.date_discovered)
    items = q.order_by(col.asc() if sort_order == "asc" else col.desc()).offset(offset).limit(limit).all()
    return {"items": items, "total": total}


@router.get("/candidates/{id}")
def get_candidate(id: int, db: Session = Depends(get_db)):
    candidate = db.get(MediaCandidate, id)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return candidate


@router.post("/candidates/{id}/approve")
def approve_candidate(id: int, body: ApproveRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    candidate = db.get(MediaCandidate, id)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Candidate not found")

    job = EncodeJob(
        candidate_id=candidate.id,
        target_codec=body.target_codec,
        use_hardware=body.use_hardware,
        hardware_type=body.hardware_type,
        quality_level=body.quality_level,
        resolution=body.resolution,
        output_mode=body.output_mode,
        status="queued",
        original_size_bytes=candidate.file_size_bytes,
    )
    db.add(job)
    candidate.status = "approved"
    db.commit()
    db.refresh(job)
    background_tasks.add_task(run_encode_job, job.id)
    return job


@router.post("/candidates/{id}/skip")
def skip_candidate(id: int, db: Session = Depends(get_db)):
    candidate = db.get(MediaCandidate, id)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Candidate not found")
    candidate.status = "skipped"
    db.commit()
    db.refresh(candidate)
    return candidate


@router.post("/candidates/{id}/ignore")
def ignore_failed_candidate(id: int, db: Session = Depends(get_db)):
    candidate = db.get(MediaCandidate, id)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Candidate not found")
    if candidate.status != "failed":
        raise HTTPException(status_code=409, detail="Only failed candidates can be ignored")

    failed_job = (
        db.query(EncodeJob)
        .filter(EncodeJob.candidate_id == id, EncodeJob.status == "failed")
        .order_by(EncodeJob.date_completed.desc(), EncodeJob.date_created.desc())
        .first()
    )
    if failed_job is None:
        raise HTTPException(status_code=409, detail="No failed job found for this candidate")

    failed_job.status = "ignored"
    if failed_job.date_completed is None:
        failed_job.date_completed = datetime.now(timezone.utc)
    candidate.status = "skipped"
    db.commit()
    db.refresh(failed_job)
    return failed_job


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

_JOB_SORT = {
    "date_created":       EncodeJob.date_created,
    "date_completed":     EncodeJob.date_completed,
    "target_codec":       EncodeJob.target_codec,
    "original_size_bytes": EncodeJob.original_size_bytes,
    "final_size_bytes":   EncodeJob.final_size_bytes,
    "status":             EncodeJob.status,
    "quality_level":      EncodeJob.quality_level,
}

@router.get("/jobs")
def list_jobs(
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    queue_order: bool = False,
    sort_by: str = "date_created",
    sort_order: str = "desc",
    db: Session = Depends(get_db),
):
    from sqlalchemy import case as sa_case
    q = db.query(EncodeJob).options(joinedload(EncodeJob.candidate))
    if status:
        statuses = [s.strip() for s in status.split(",")]
        q = q.filter(EncodeJob.status.in_(statuses))
    total = q.count()
    if queue_order:
        order_expr = sa_case((EncodeJob.status == "encoding", 0), (EncodeJob.status == "paused", 1), else_=2)
        items = q.order_by(order_expr, EncodeJob.id.asc()).offset(offset).limit(limit).all()
    else:
        col = _JOB_SORT.get(sort_by, EncodeJob.date_created)
        items = q.order_by(col.asc() if sort_order == "asc" else col.desc()).offset(offset).limit(limit).all()

    return {"items": items, "total": total}


@router.get("/encoding-status")
def encoding_status(db: Session = Depends(get_db)):
    """Lightweight summary used by the global encoding banner.
    Returns minimal data — no ORM serialisation gotchas."""
    from pathlib import Path as _Path
    jobs = (
        db.query(EncodeJob)
        .options(joinedload(EncodeJob.candidate))
        .filter(EncodeJob.status.in_(["encoding", "paused", "queued"]))
        .all()
    )
    encoding, paused = [], []
    queued_count = 0
    for job in jobs:
        if job.status == "queued":
            queued_count += 1
            continue
        p = get_job_progress(job.id) if job.status == "encoding" else None
        entry = {
            "id": job.id,
            "filename": _Path(job.candidate.file_path).name if job.candidate else "Unknown",
            "progress_percent": p.get("percent", 0) if p else 0,
            "eta_seconds": p.get("eta_seconds") if p else None,
            "status": job.status,
        }
        if job.status == "encoding":
            encoding.append(entry)
        else:
            paused.append(entry)
    return {"encoding": encoding, "paused": paused, "queued_count": queued_count}


@router.get("/jobs/{id}")
def get_job(id: int, db: Session = Depends(get_db)):
    job = db.get(EncodeJob, id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/jobs/{id}/cancel")
def cancel_job(id: int, db: Session = Depends(get_db)):
    job = db.query(EncodeJob).options(joinedload(EncodeJob.candidate)).filter(EncodeJob.id == id).first()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in ("encoding", "paused"):
        raise HTTPException(status_code=409, detail="Only encoding or paused jobs can be cancelled")

    kill_encode_process(job.id)
    job.status = "failed"
    job.error_message = "Cancelled by user"
    job.date_completed = datetime.now(timezone.utc)
    if job.candidate:
        job.candidate.status = "pending"
    db.commit()
    db.refresh(job)
    return job


@router.post("/jobs/{id}/pause")
def pause_encode_job(id: int, db: Session = Depends(get_db)):
    job = db.get(EncodeJob, id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in ("encoding", "queued"):
        raise HTTPException(status_code=409, detail="Only encoding or queued jobs can be paused")
    if job.status == "encoding":
        err = pause_job(id, release_slot=True)
        if err:
            raise HTTPException(status_code=500, detail=f"Failed to pause job: {err}")
        # After releasing the slot, kick off any queued jobs that can now start.
        # The semaphore release will wake a waiting thread, but dispatch_queued_jobs
        # is a safety net for jobs whose threads are no longer blocking on the semaphore.
        dispatch_queued_jobs()
    # For queued jobs: DB-only pause — the thread blocking on the semaphore will skip when it acquires
    job.status = "paused"
    db.commit()
    return {"id": id, "status": "paused"}


@router.post("/jobs/{id}/resume")
def resume_encode_job(id: int, db: Session = Depends(get_db)):
    job = db.get(EncodeJob, id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "paused":
        raise HTTPException(status_code=409, detail="Only paused jobs can be resumed")
    err = resume_job(id)
    if err:
        raise HTTPException(status_code=500, detail=f"Failed to resume job: {err}")
    # Refresh to pick up any DB changes made by resume_job (e.g. DB-only pause → "queued")
    db.refresh(job)
    if job.status == "paused" and id not in _encoder_sem_released:
        # Manual pause (slot retained) — update DB immediately
        job.status = "encoding"
        db.commit()
    return {"id": id, "status": job.status}


@router.post("/jobs/{id}/remove")
def remove_job(id: int, db: Session = Depends(get_db)):
    job = db.query(EncodeJob).options(joinedload(EncodeJob.candidate)).filter(EncodeJob.id == id).first()
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "queued":
        raise HTTPException(status_code=409, detail="Only queued jobs can be removed")

    if job.candidate:
        job.candidate.status = "pending"
    db.delete(job)
    db.commit()
    return {"message": "Job removed"}


@router.post("/jobs/{id}/retry")
def retry_job(id: int, body: ApproveRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    failed_job = db.query(EncodeJob).options(joinedload(EncodeJob.candidate)).filter(EncodeJob.id == id).first()
    if failed_job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if failed_job.status != "failed":
        raise HTTPException(status_code=409, detail="Only failed jobs can be retried")

    new_job = EncodeJob(
        candidate_id=failed_job.candidate_id,
        target_codec=body.target_codec,
        use_hardware=body.use_hardware,
        hardware_type=body.hardware_type,
        quality_level=body.quality_level,
        resolution=body.resolution,
        output_mode=body.output_mode,
        status="queued",
        original_size_bytes=failed_job.original_size_bytes,
    )
    db.add(new_job)
    failed_job.candidate.status = "approved"
    db.commit()
    db.refresh(new_job)
    background_tasks.add_task(run_encode_job, new_job.id)
    return new_job


@router.post("/jobs/dispatch")
def dispatch_jobs(db: Session = Depends(get_db)):
    dispatch_queued_jobs()
    return {"message": "Jobs dispatched"}


@router.post("/jobs/pause-all")
def pause_all_jobs(db: Session = Depends(get_db)):
    encoding_jobs = db.query(EncodeJob).filter(EncodeJob.status == "encoding").all()
    for job in encoding_jobs:
        # release_slot=True frees the semaphore but we deliberately don't call
        # dispatch_queued_jobs() here — the intent is to pause everything, not
        # replace paused jobs with queued ones immediately.
        err = pause_job(job.id, release_slot=True)
        if not err:
            job.status = "paused"
    db.commit()
    return {"message": f"Paused {len(encoding_jobs)} job(s)"}


@router.post("/jobs/resume-all")
def resume_all_jobs(db: Session = Depends(get_db)):
    paused_jobs = db.query(EncodeJob).filter(EncodeJob.status == "paused").all()
    for job in paused_jobs:
        resume_job(job.id)
    db.commit()
    return {"message": f"Resumed {len(paused_jobs)} job(s)"}


@router.post("/jobs/cancel-all")
def cancel_all_jobs(db: Session = Depends(get_db)):
    jobs = db.query(EncodeJob).filter(EncodeJob.status.in_(["encoding", "queued", "paused"])).all()
    for job in jobs:
        if job.status == "encoding":
            kill_encode_process(job.id)
        job.status = "failed"
        job.error_message = "Cancelled by user"
        job.date_completed = datetime.now(timezone.utc)
        if job.candidate:
            job.candidate.status = "pending"
    db.commit()
    return {"message": f"Cancelled {len(jobs)} job(s)"}


@router.post("/jobs/stop-all")
def stop_all_jobs(db: Session = Depends(get_db)):
    """Stop all active work and return every item to the candidates queue.

    Encoding/paused jobs: kill the process, mark as failed (preserved in History).
    Queued jobs that never started: delete the record entirely so they don't
    pollute History — the candidate is simply returned to pending.
    """
    jobs = db.query(EncodeJob).options(joinedload(EncodeJob.candidate)).filter(
        EncodeJob.status.in_(["encoding", "paused", "queued"])
    ).all()
    stopped = 0
    removed = 0
    for job in jobs:
        if job.candidate:
            job.candidate.status = "pending"
        if job.status in ("encoding", "paused"):
            kill_encode_process(job.id)
            job.status = "failed"
            job.error_message = "Stopped by user"
            job.date_completed = datetime.now(timezone.utc)
            stopped += 1
        else:
            # queued — never ran, delete cleanly
            db.delete(job)
            removed += 1
    db.commit()
    return {"message": f"Stopped {stopped} job(s), removed {removed} queued job(s)"}


# ---------------------------------------------------------------------------
# Filesystem browser
# ---------------------------------------------------------------------------

_BROWSE_ROOT = "/media"

@router.get("/browse")
def browse_directory(path: str = "/media"):
    try:
        resolved = str(FSPath(path).resolve())
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid path")

    if not (resolved == _BROWSE_ROOT or resolved.startswith(_BROWSE_ROOT + "/")):
        raise HTTPException(status_code=403, detail="Access restricted to /media")

    browse_path = FSPath(resolved)
    if not browse_path.exists() or not browse_path.is_dir():
        raise HTTPException(status_code=404, detail="Path not found or not a directory")

    try:
        dirs = sorted(
            [{"name": e.name, "path": str(e)} for e in browse_path.iterdir()
             if e.is_dir() and not e.name.startswith(".")],
            key=lambda d: d["name"].lower(),
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

    parent = str(browse_path.parent) if resolved != _BROWSE_ROOT else None

    return {"current": resolved, "parent": parent, "dirs": dirs}


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------

@router.post("/scan")
def trigger_scan(db: Session = Depends(get_db)):
    libraries = db.query(MediaLibrary).filter(MediaLibrary.enabled == True).all()
    if not libraries:
        raise HTTPException(status_code=409, detail="No media libraries configured — add a library in Settings before scanning")
    return scan_library()


@router.post("/settings/libraries/{id}/scan")
def scan_single_library(id: int, db: Session = Depends(get_db)):
    library = db.get(MediaLibrary, id)
    if library is None:
        raise HTTPException(status_code=404, detail="Library not found")
    if not library.enabled:
        raise HTTPException(status_code=409, detail="Library is disabled")
    return scan_library(library_id=id)


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

@router.get("/status")
def get_status():
    return {
        "scan": get_scan_status(),
        "queue": get_queue_status(),
    }


def get_gpu_metrics():
    """Get GPU utilization via nvidia-smi. Returns (system_gpu%, container_gpu%) or (None, None) if unavailable."""
    try:
        import subprocess

        # Get system-wide GPU utilization
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=2
        )
        if result.returncode != 0:
            return None, None

        gpu_util = result.stdout.strip()
        system_gpu = float(gpu_util) if gpu_util else None

        # Container GPU mirrors system GPU since encodarr is typically the only GPU user
        # During encoding (FFmpeg child process), this shows actual usage
        # When idle, this shows 0%
        container_gpu = system_gpu

        return system_gpu, container_gpu
    except Exception:
        pass
    return None, None


@router.get("/system")
def get_system():
    mem = psutil.virtual_memory()
    process = psutil.Process()
    container_mem_bytes = process.memory_info().rss
    container_mem_percent = (container_mem_bytes / mem.total * 100) if mem.total > 0 else 0

    cpu_count = psutil.cpu_count() or 1

    # Include child processes (FFmpeg subprocesses) in container CPU measurement.
    # Seed all process CPU meters, then block once for the host interval, then read deltas.
    try:
        all_procs = [process] + process.children(recursive=True)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        all_procs = [process]
    for p in all_procs:
        try:
            p.cpu_percent(interval=None)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    gpu_percent, container_gpu_percent = get_gpu_metrics()


    return {
        # Host metrics — cpu_percent(interval=0.5) blocks 0.5s, giving child procs time to accumulate
        "cpu_percent": psutil.cpu_percent(interval=0.5),
        "cpu_count": cpu_count,
        "memory_percent": mem.percent,
        "memory_used_bytes": mem.used,
        "memory_total_bytes": mem.total,
        "gpu_percent": gpu_percent,
        # Container metrics
        "container_cpu_percent": sum(
            p.cpu_percent(interval=None) for p in all_procs
            if p.is_running()
        ) / cpu_count,
        "container_memory_bytes": container_mem_bytes,
        "container_memory_percent": container_mem_percent,
        "container_gpu_percent": container_gpu_percent,
    }


@router.get("/hardware")
def get_hardware():
    return _available_hardware


@router.get("/progress")
def get_progress(db: Session = Depends(get_db)):
    encoding_job = (
        db.query(EncodeJob)
        .options(joinedload(EncodeJob.candidate))
        .filter(EncodeJob.status == "encoding")
        .first()
    )

    current_job_id = encoding_job.id if encoding_job else None
    progress = get_job_progress(current_job_id) if current_job_id is not None else None
    current_job_percent = progress["percent"] if progress else None
    current_job_filename = None
    if encoding_job and encoding_job.candidate:
        from pathlib import Path
        current_job_filename = Path(encoding_job.candidate.file_path).name

    q = get_queue_status()
    active_jobs = q["queued"] + q["encoding"] + q["paused"]

    # Only show queue percent if there are active/queued/paused jobs
    # When queue is empty, return None to show dash
    queue_percent = None
    if active_jobs > 0:
        # Scope "complete" to the current batch only — jobs created since the oldest
        # still-active job. Counting all-time completes inflates progress from the start.
        oldest_active_ts = db.query(func.min(EncodeJob.date_created)).filter(
            EncodeJob.status.in_(["queued", "encoding", "paused"])
        ).scalar()
        batch_complete = db.query(EncodeJob).filter(
            EncodeJob.status == "complete",
            EncodeJob.date_created >= oldest_active_ts,
        ).count() if oldest_active_ts else 0

        all_encoding = db.query(EncodeJob).filter(EncodeJob.status == "encoding").all()
        in_progress = sum((get_job_progress(j.id) or {}).get("percent", 0.0) / 100.0 for j in all_encoding)
        batch_total = batch_complete + active_jobs
        queue_percent = round(((batch_complete + in_progress) / batch_total * 100.0), 1) if batch_total > 0 else 0.0

    return {
        "current_job_id": current_job_id,
        "current_job_percent": current_job_percent,
        "current_job_filename": current_job_filename,
        "queue_percent": queue_percent,
        "queue_depth": active_jobs,
        "encoding_count": q["encoding"],
        "paused_count": q["paused"],
    }


# ---------------------------------------------------------------------------
# Auto-approve rules
# ---------------------------------------------------------------------------

@router.get("/auto-approve/rules")
def list_auto_approve_rules(db: Session = Depends(get_db)):
    return db.query(AutoApproveRule).order_by(AutoApproveRule.date_created).all()


@router.post("/auto-approve/rules")
def create_auto_approve_rule(body: AutoApproveRuleRequest, db: Session = Depends(get_db)):
    rule = AutoApproveRule(
        name=body.name,
        enabled=body.enabled,
        min_savings_percent=body.min_savings_percent,
        resolutions=body.resolutions or None,
        source_codecs=body.source_codecs or None,
        target_codec=body.target_codec,
        target_resolution=body.target_resolution or None,
        output_mode=body.output_mode,
        quality_level=body.quality_level,
        use_hardware=body.use_hardware,
        rename_enabled=body.rename_enabled,
        rename_custom_text_enabled=body.rename_custom_text_enabled,
        rename_custom_text=body.rename_custom_text,
        rename_include_codec=body.rename_include_codec,
        rename_include_resolution=body.rename_include_resolution,
        rename_separator=body.rename_separator,
        library_id=body.library_id,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.put("/auto-approve/rules/{id}")
def update_auto_approve_rule(id: int, body: AutoApproveRuleUpdateRequest, db: Session = Depends(get_db)):
    rule = db.get(AutoApproveRule, id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    for field in body.model_fields_set:
        setattr(rule, field, getattr(body, field))
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/auto-approve/rules/{id}")
def delete_auto_approve_rule(id: int, db: Session = Depends(get_db)):
    rule = db.get(AutoApproveRule, id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    db.delete(rule)
    db.commit()
    return {"message": "Rule deleted"}


@router.post("/auto-approve/evaluate")
def trigger_auto_approve():
    result = evaluate_auto_approve()
    return result


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

# Settings keys that must never be sent to the client. secret_key signs session
# tokens (leaking it lets anyone forge a valid cookie); auth_password_hash is the
# bcrypt hash. The frontend only needs to know whether auth is on, exposed as the
# derived auth_enabled bool below.
_SETTINGS_SECRET_KEYS = {"secret_key", "auth_password_hash"}


@router.get("/settings")
def get_settings():
    settings = get_all_settings()
    scan_info = get_scheduled_scan_info()
    auth_enabled = bool(settings.get("auth_password_hash"))
    public_settings = {k: v for k, v in settings.items() if k not in _SETTINGS_SECRET_KEYS}
    return {
        **public_settings,
        "auth_enabled": auth_enabled,
        **scan_info,
    }


@router.put("/settings")
def update_settings(body: dict, db: Session = Depends(get_db)):
    for key, value in body.items():
        set_setting(key, str(value))
    if "max_concurrent_encodes" in body:
        new_limit = max(1, min(int(body["max_concurrent_encodes"]), 5))
        reset_encode_semaphore()

        encoding_jobs = (
            db.query(EncodeJob)
            .filter(EncodeJob.status == "encoding")
            .order_by(EncodeJob.date_created.desc())
            .all()
        )
        currently_encoding = len(encoding_jobs)

        if currently_encoding > new_limit:
            # Reduce active encodes to match new limit by pausing newest jobs
            for job in encoding_jobs[:currently_encoding - new_limit]:
                if pause_job(job.id, release_slot=True) is None:
                    job.status = "paused"
            db.commit()
        else:
            # Resume paused jobs to fill newly available slots
            paused_jobs = (
                db.query(EncodeJob)
                .filter(EncodeJob.status == "paused")
                .order_by(EncodeJob.date_created)
                .all()
            )
            slots_available = new_limit - currently_encoding
            for job in paused_jobs[:slots_available]:
                if resume_job(job.id) is None:
                    job.status = "encoding"
            db.commit()
            dispatch_queued_jobs()

    return get_all_settings()


@router.post("/notifications/test")
def test_notification():
    from notifications import send_notification
    if get_all_settings().get("notifications_enabled") != "true":
        raise HTTPException(status_code=400, detail="Notifications are disabled")
    send_notification("Encodarr — Test Notification", "Notifications are working correctly.")
    return {"ok": True}


@router.get("/settings/libraries")
def list_libraries(db: Session = Depends(get_db)):
    return db.query(MediaLibrary).all()


@router.post("/settings/libraries")
def create_library(body: LibraryRequest, db: Session = Depends(get_db)):
    existing = db.query(MediaLibrary).filter_by(path=body.path).first()
    if existing:
        raise HTTPException(status_code=409, detail="A library with this path already exists")
    library = MediaLibrary(
        path=body.path,
        label=body.label,
        date_added=datetime.now(timezone.utc),
    )
    db.add(library)
    db.commit()
    db.refresh(library)
    return library


@router.put("/settings/libraries/{id}")
def update_library(id: int, body: LibraryUpdateRequest, db: Session = Depends(get_db)):
    library = db.get(MediaLibrary, id)
    if library is None:
        raise HTTPException(status_code=404, detail="Library not found")
    if body.label is not None:
        library.label = body.label
    if body.enabled is not None:
        library.enabled = body.enabled
    db.commit()
    db.refresh(library)
    return library


@router.delete("/settings/libraries/{id}")
def delete_library(id: int, db: Session = Depends(get_db)):
    library = db.get(MediaLibrary, id)
    if library is None:
        raise HTTPException(status_code=404, detail="Library not found")
    db.delete(library)
    db.commit()
    return {"message": "Library removed"}


@router.post("/settings/reset-missing")
def reset_missing(db: Session = Depends(get_db)):
    """Delete all candidates with status=missing, clearing the missing files counter."""
    deleted = db.query(MediaCandidate).filter(MediaCandidate.status == "missing").delete(synchronize_session=False)
    db.commit()
    return {"deleted": deleted}


@router.post("/settings/reset-scan")
def reset_scan_history(db: Session = Depends(get_db)):
    """Fully purge all scan data - delete ALL candidates to reset to baseline."""
    deleted = db.query(MediaCandidate).delete(synchronize_session=False)
    db.commit()
    return {
        "deleted": deleted,
        "total_affected": deleted
    }


@router.post("/settings/reset-history")
def reset_encode_history(db: Session = Depends(get_db)):
    """Delete completed, failed, and ignored encode jobs."""
    deleted = db.query(EncodeJob).filter(
        EncodeJob.status.in_(["complete", "failed", "ignored"])
    ).delete(synchronize_session=False)

    db.commit()
    return {
        "deleted": deleted
    }


@router.post("/settings/reset-all")
def reset_all_history(db: Session = Depends(get_db)):
    """Fully reset everything - purge all candidates, encode jobs, and settings to defaults."""
    # Delete ALL candidates (scan logs)
    candidates_deleted = db.query(MediaCandidate).delete(synchronize_session=False)

    # Delete ALL jobs (encode history)
    jobs_deleted = db.query(EncodeJob).delete(synchronize_session=False)

    # Delete ALL settings (reset to defaults)
    settings_deleted = db.query(AppSetting).delete(synchronize_session=False)

    db.commit()
    return {
        "candidates_deleted": candidates_deleted,
        "jobs_deleted": jobs_deleted,
        "settings_deleted": settings_deleted,
        "total_affected": candidates_deleted + jobs_deleted + settings_deleted
    }


# ---------------------------------------------------------------------------
# Scheduled Governor Windows
# ---------------------------------------------------------------------------

@router.get("/governor/windows")
def list_governor_windows(db: Session = Depends(get_db)):
    windows = db.query(ScheduledGovernor).order_by(ScheduledGovernor.start_time).all()
    return [
        {
            "id": w.id, "label": w.label, "start_time": w.start_time,
            "end_time": w.end_time, "cpu_limit": w.cpu_limit,
            "max_concurrent": w.max_concurrent, "enabled": w.enabled,
        }
        for w in windows
    ]


@router.post("/governor/windows")
def create_governor_window(body: GovernorWindowRequest, db: Session = Depends(get_db)):
    w = ScheduledGovernor(**body.dict(), gpu_limit=100)
    db.add(w)
    db.commit()
    db.refresh(w)
    return {"id": w.id}


@router.put("/governor/windows/{window_id}")
def update_governor_window(window_id: int, body: GovernorWindowRequest, db: Session = Depends(get_db)):
    w = db.get(ScheduledGovernor, window_id)
    if not w:
        raise HTTPException(status_code=404, detail="Window not found")
    for k, v in body.dict().items():
        setattr(w, k, v)
    w.gpu_limit = 100
    db.commit()
    return {"ok": True}


@router.delete("/governor/windows/{window_id}")
def delete_governor_window(window_id: int, db: Session = Depends(get_db)):
    w = db.get(ScheduledGovernor, window_id)
    if not w:
        raise HTTPException(status_code=404, detail="Window not found")
    db.delete(w)
    db.commit()
    return {"ok": True}


@router.get("/governor/status")
def governor_status():
    return {"active": get_governor_active(), "overrides": get_governor_overrides()}
