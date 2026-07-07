import logging
import os
import re
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

TRANSCODE_PATH = os.environ.get("TRANSCODE_PATH", "/transcode")

from sqlalchemy import func

from database import EncodeJob, MediaCandidate, Session, engine
from notifications import send_notification
from settings import get_effective_setting, get_setting

logger = logging.getLogger(__name__)

_encode_semaphore: threading.Semaphore | None = None
_encode_semaphore_lock = threading.Lock()
_running_jobs: dict[int, subprocess.Popen] = {}
_cpulimit_procs: dict[int, subprocess.Popen] = {}
_cancelled_jobs: set[int] = set()
_paused_jobs: set[int] = set()
_sem_released: set[int] = set()  # jobs whose semaphore slot was released externally during pause
_pending_threads: set[int] = set()  # job_ids with a live thread (blocking on semaphore or running)
_job_progress: dict[int, dict] = {}
_available_hardware: dict = {"nvenc": False, "vaapi": False, "videotoolbox": False, "any": False}


def _get_encode_semaphore() -> threading.Semaphore:
    global _encode_semaphore
    if _encode_semaphore is None:
        with _encode_semaphore_lock:
            if _encode_semaphore is None:
                n = max(1, min(int(get_effective_setting("max_concurrent_encodes", "1") or "1"), 5))
                _encode_semaphore = threading.Semaphore(n)
                logger.info("Encode semaphore initialised with n=%d", n)
    return _encode_semaphore


def reset_encode_semaphore() -> None:
    global _encode_semaphore
    with _encode_semaphore_lock:
        n = max(1, min(int(get_effective_setting("max_concurrent_encodes", "1") or "1"), 5))
        _encode_semaphore = threading.Semaphore(n)
        logger.info("Encode semaphore reset with n=%d", n)


def dispatch_queued_jobs() -> None:
    """Start any queued jobs that can now run given the current semaphore capacity."""
    with Session(engine) as db:
        queued = db.query(EncodeJob).filter(EncodeJob.status == "queued").all()
        job_ids = [j.id for j in queued]
    for job_id in job_ids:
        if job_id not in _running_jobs and job_id not in _pending_threads:
            threading.Thread(target=run_encode_job, args=(job_id,), daemon=True).start()


def _detect_vaapi(encoders_output: str) -> bool:
    """Check whether VAAPI is genuinely usable for encoding.

    The render node /dev/dri/renderD128 exists on NVIDIA systems too (via
    nvidia-drm), but those don't support hevc_vaapi. We read the vendor ID
    from sysfs to confirm the device is AMD (0x1002) or Intel (0x8086).
    Falls back to a probe encode if sysfs isn't available.
    """
    if "hevc_vaapi" not in encoders_output:
        return False
    render = Path("/dev/dri/renderD128")
    if not render.exists():
        return False
    # Prefer sysfs vendor check (fast, no subprocess)
    vendor_path = Path("/sys/class/drm/renderD128/device/vendor")
    if vendor_path.exists():
        try:
            vendor = vendor_path.read_text().strip().lower()
            # 0x1002 = AMD, 0x8086 = Intel
            if vendor not in ("0x1002", "0x8086"):
                logger.debug("VAAPI render node vendor %s is not AMD/Intel — skipping", vendor)
                return False
            return True
        except OSError:
            pass
    # sysfs unavailable — do a 1-frame probe encode to confirm
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-init_hw_device", "vaapi=va:/dev/dri/renderD128",
             "-filter_hw_device", "va",
             "-f", "lavfi", "-i", "nullsrc=s=64x64",
             "-frames:v", "1",
             "-vf", "format=nv12,hwupload",
             "-c:v", "hevc_vaapi",
             "-f", "null", "-"],
            capture_output=True, timeout=8,
        )
        return result.returncode == 0
    except Exception as exc:
        logger.debug("VAAPI probe failed: %s", exc)
        return False


def detect_hardware_encoders() -> dict:
    global _available_hardware
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=10,
        )
        encoders_output = result.stdout + result.stderr
    except Exception as exc:
        logger.warning("Could not run ffmpeg encoder detection: %s", exc)
        encoders_output = ""

    nvenc = "hevc_nvenc" in encoders_output
    vaapi = _detect_vaapi(encoders_output)
    videotoolbox = "hevc_videotoolbox" in encoders_output

    if nvenc:
        logger.info("Hardware encoder detected: NVENC")
    if vaapi:
        logger.info("Hardware encoder detected: VAAPI")
    if videotoolbox:
        logger.info("Hardware encoder detected: VideoToolbox")
    if not any([nvenc, vaapi, videotoolbox]):
        logger.info("No hardware encoders detected — software encoding only")

    _available_hardware.update({
        "nvenc": nvenc,
        "vaapi": vaapi,
        "videotoolbox": videotoolbox,
        "any": nvenc or vaapi or videotoolbox,
    })
    logger.info("Available hardware encoders: %s", _available_hardware)
    return _available_hardware


def calculate_thread_count() -> int:
    cpu_limit_percent = int(get_effective_setting("encode_cpu_limit_percent", "80") or "80")
    cpu_count = os.cpu_count() or 1
    threads = max(1, int(cpu_count * cpu_limit_percent / 100))
    logger.debug("Thread count: %d (cpu_count=%d, limit=%d%%)", threads, cpu_count, cpu_limit_percent)
    return threads


def _start_cpulimit(job_id: int, pid: int) -> None:
    """Spawn a cpulimit process to hard-cap the FFmpeg process CPU usage.

    cpulimit -l expects percentage of one CPU core, so we multiply the
    user's total-CPU-% setting by core count to get the equivalent single-core %.
    Example: 10% limit on 16 cores → cpulimit -l 160 (= 1.6 cores = 10% of system).
    """
    cpu_limit = int(get_effective_setting("encode_cpu_limit_percent", "80") or "80")
    if cpu_limit >= 100:
        return
    cpu_count = os.cpu_count() or 1
    cpulimit_val = cpu_limit * cpu_count
    try:
        proc = subprocess.Popen(
            ["cpulimit", "-p", str(pid), "-l", str(cpulimit_val), "-z"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        _cpulimit_procs[job_id] = proc
        logger.info("cpulimit started for job %d (pid %d, limit=%d%% = -l %d)", job_id, pid, cpu_limit, cpulimit_val)
    except FileNotFoundError:
        logger.warning("cpulimit not found — CPU limit not enforced for job %d", job_id)


def _stop_cpulimit(job_id: int) -> None:
    proc = _cpulimit_procs.pop(job_id, None)
    if proc and proc.poll() is None:
        proc.terminate()


CRF = {
    "hevc": {1: 32, 2: 30, 3: 28, 4: 24, 5: 20},
    "av1":  {1: 45, 2: 40, 3: 35, 4: 30, 5: 25},
}

# NVENC constant quality: lower CQ = higher quality (VBR mode, -b:v 0 removes bitrate cap)
NVENC_CQ = {1: 28, 2: 24, 3: 20, 4: 16, 5: 12}


def _build_ffmpeg_command(job: EncodeJob, input_path: str, output_path: str) -> list[str]:
    codec = job.target_codec  # hevc | av1
    is_hardware = bool(job.use_hardware and job.hardware_type)

    if is_hardware:
        hw = job.hardware_type
        if hw == "nvenc":
            video_codec = "hevc_nvenc" if codec == "hevc" else "av1_nvenc"
            preset = "p4"
        elif hw == "vaapi":
            video_codec = "hevc_vaapi"
            preset = None
        elif hw == "videotoolbox":
            video_codec = "hevc_videotoolbox"
            preset = None
        else:
            video_codec = "libx265" if codec == "hevc" else "libsvtav1"
            preset = "slow"
            is_hardware = False  # unrecognised hw type, treated as software
    else:
        hw = None
        video_codec = "libx265" if codec == "hevc" else "libsvtav1"
        preset = "slow"

    # -map 0:v:0 picks only the primary video stream — skips attached-picture
    # streams (cover art / mjpeg thumbnails) that otherwise get fed into the
    # output filter graph and trigger ENOSYS during format negotiation.
    cmd = ["ffmpeg", "-y", "-progress", "pipe:1", "-nostats", "-i", input_path,
           "-map", "0:v:0", "-map", "0:a?", "-map", "0:s?",
           "-c:v", video_codec]

    if preset:
        cmd += ["-preset", preset]

    # CRF and thread throttle apply to software encoders only
    if not is_hardware:
        quality = job.quality_level or 3
        crf_value = CRF.get(codec, {}).get(quality, 28)
        cmd += ["-crf", str(crf_value)]
        cmd += ["-threads", str(calculate_thread_count())]
    else:
        # GPU quality and throttle
        if hw == "nvenc":
            quality = job.quality_level or 3
            cq_value = NVENC_CQ.get(quality, 20)
            cmd += ["-rc", "vbr", "-cq", str(cq_value), "-b:v", "0"]
            logger.debug("NVENC quality: cq=%d (quality_level=%d)", cq_value, quality)

    if job.resolution == "4k":
        cmd += ["-vf", "scale=-2:2160"]
    elif job.resolution == "1080p":
        cmd += ["-vf", "scale=-2:1080"]
    elif job.resolution == "720p":
        cmd += ["-vf", "scale=-2:720"]
    elif job.resolution == "480p":
        cmd += ["-vf", "scale=-2:480"]

    cmd += ["-c:a", "copy", "-c:s", "copy", output_path]
    return cmd


def _get_duration_seconds(input_path: str) -> float:
    """Get video duration in seconds via ffprobe. Used for time-based progress %."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error",
             "-show_entries", "format=duration",
             "-of", "csv=p=0",
             "--",  # end of options: guard against leading-dash filenames
             input_path],
            capture_output=True, text=True, timeout=10,
        )
        val = result.stdout.strip()
        return float(val) if val and val != "N/A" else 0.0
    except Exception:
        return 0.0


def get_job_progress(job_id: int) -> dict | None:
    return _job_progress.get(job_id)


def _jget(job, attr: str, setting_key: str, truthy: bool = False):
    """Return job-level override if set, else fall back to global setting."""
    val = getattr(job, attr, None)
    if val is not None:
        return val
    raw = get_setting(setting_key) or ""
    return (raw == "true") if truthy else raw


def _build_output_filename(p: Path, job) -> str:
    """Return the final output path for this job based on rename settings."""
    output_mode = job.output_mode or "replace"
    enabled_key = "rename_copy_enabled" if output_mode == "copy" else "rename_replace_enabled"

    rename_on = job.rename_enabled if job.rename_enabled is not None else (get_setting(enabled_key) == "true")
    if not rename_on:
        return str(p.with_name(p.stem + "_copy" + p.suffix)) if output_mode == "copy" else str(p)

    sep = _jget(job, "rename_separator", "rename_separator") or "_"
    parts = [p.stem]

    if _jget(job, "rename_custom_text_enabled", "rename_custom_text_enabled", truthy=True):
        text = (_jget(job, "rename_custom_text", "rename_custom_text") or "").strip()
        if text:
            parts.append(text)

    if _jget(job, "rename_include_codec", "rename_include_codec", truthy=True) and job.target_codec:
        parts.append(job.target_codec)

    if _jget(job, "rename_include_resolution", "rename_include_resolution", truthy=True) and job.resolution:
        parts.append(job.resolution)

    return str(p.with_name(sep.join(parts) + p.suffix))


def run_encode_job(job_id: int) -> None:
    _pending_threads.add(job_id)
    sem = _get_encode_semaphore()
    sem.acquire()
    _pending_threads.discard(job_id)
    try:
        with Session(engine) as db:
            job = db.get(EncodeJob, job_id)
            if job is None:
                logger.error("EncodeJob %d not found", job_id)
                return

            # Job may have been paused (DB-only) or cancelled while waiting for the semaphore
            if job.status != "queued":
                logger.info("Job %d has status '%s' after acquiring slot — skipping", job_id, job.status)
                return

            candidate = db.get(MediaCandidate, job.candidate_id)
            if candidate is None:
                logger.error("MediaCandidate %d not found for job %d", job.candidate_id, job_id)
                return

            input_path = candidate.file_path
            p = Path(input_path)
            output_mode = job.output_mode or "replace"
            final_path = _build_output_filename(p, job)
            transcode_file = Path(TRANSCODE_PATH) / (p.stem + ".tmp" + p.suffix)
            output_path = str(transcode_file)

            logger.info("Starting encode job %d: %s -> %s", job_id, input_path, job.target_codec)

            job.status = "encoding"
            candidate.status = "encoding"
            db.commit()

            total_duration = _get_duration_seconds(input_path)
            _job_progress[job_id] = {"elapsed_seconds": 0.0, "total_duration": total_duration, "percent": 0.0}

            cmd = _build_ffmpeg_command(job, input_path, output_path)
            logger.debug("FFmpeg command: %s", " ".join(cmd))

            # out_time_ms is written to stdout via -progress pipe:1 (value is in microseconds)
            _time_re = re.compile(r"out_time_ms=(\d+)")
            _error_re = re.compile(r"Error|error|Invalid|No such|failed|Unable")
            stderr_lines: list[str] = []

            try:
                process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    universal_newlines=True,
                )
                _running_jobs[job_id] = process
                _start_cpulimit(job_id, process.pid)

                def _drain_stderr():
                    for line in process.stderr:
                        stripped = line.rstrip()
                        if stripped:
                            stderr_lines.append(stripped)

                stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
                stderr_thread.start()

                for line in process.stdout:
                    m = _time_re.search(line)
                    if m:
                        elapsed_s = int(m.group(1)) / 1_000_000
                        pct = (elapsed_s / total_duration * 100.0) if total_duration > 0 else 0.0
                        _job_progress[job_id]["elapsed_seconds"] = elapsed_s
                        _job_progress[job_id]["percent"] = min(pct, 100.0)
                        # Calculate ETA: if we have progress, extrapolate remaining time
                        if pct > 0 and pct < 100:
                            total_est_s = elapsed_s / (pct / 100.0)
                            eta_s = max(0, total_est_s - elapsed_s)
                            _job_progress[job_id]["eta_seconds"] = eta_s
                        elif pct >= 100:
                            _job_progress[job_id]["eta_seconds"] = 0

                process.wait()
                stderr_thread.join()
                _running_jobs.pop(job_id, None)
                _stop_cpulimit(job_id)

                if process.returncode != 0:
                    logger.error(
                        "FFmpeg failed for job %d (exit %d):\n%s",
                        job_id,
                        process.returncode,
                        "\n".join(stderr_lines),
                    )
                    filtered = [l for l in stderr_lines if _error_re.search(l)]
                    error_msg = "\n".join(filtered) if filtered else "\n".join(stderr_lines[-5:])
                    raise subprocess.CalledProcessError(process.returncode, cmd, None, error_msg)

                logger.info("FFmpeg completed for job %d, writing to %s", job_id, final_path)
                encoded_size = os.path.getsize(output_path)
                original_size = job.original_size_bytes or os.path.getsize(input_path)
                if encoded_size >= original_size:
                    raise RuntimeError(
                        f"Encoded file is larger than original "
                        f"({encoded_size // 1_048_576} MB vs {original_size // 1_048_576} MB) — "
                        f"original left untouched"
                    )
                shutil.copy2(output_path, final_path)
                os.remove(output_path)
                # Replace mode: delete original if it was renamed to a different path
                if output_mode == "replace" and final_path != input_path:
                    os.remove(input_path)
                job.final_size_bytes = os.path.getsize(final_path)

                _job_progress[job_id]["percent"] = 100.0
                job.status = "complete"
                candidate.status = "complete"
                logger.info(
                    "Job %d complete. Final size: %d bytes", job_id, job.final_size_bytes
                )
                fname = os.path.basename(candidate.file_path)
                orig = job.original_size_bytes or 0
                final = job.final_size_bytes or 0
                savings = round((1 - final / orig) * 100) if orig else 0
                send_notification(
                    f"Encode Complete — {fname}",
                    f"{fname} encoded successfully.\nOriginal: {orig // 1_048_576} MB  →  Final: {final // 1_048_576} MB  ({savings}% smaller)",
                )

            except Exception as exc:
                _running_jobs.pop(job_id, None)
                _stop_cpulimit(job_id)
                was_cancelled = job_id in _cancelled_jobs
                _cancelled_jobs.discard(job_id)
                if job_id in _job_progress:
                    _job_progress[job_id]["percent"] = 0.0
                logger.error("Encode job %d failed: %s", job_id, exc)
                if os.path.exists(output_path):
                    os.remove(output_path)
                    logger.debug("Removed output file %s", output_path)
                job.status = "failed"
                candidate.status = "failed"
                if was_cancelled:
                    job.error_message = "Cancelled by user"
                else:
                    job.error_message = getattr(exc, "stderr", None) or str(exc)
                    fname = os.path.basename(candidate.file_path)
                    send_notification(
                        f"Encode Failed — {fname}",
                        f"{fname} failed to encode.\n{job.error_message[:200]}",
                    )

            finally:
                job.date_completed = datetime.now(timezone.utc)
                db.commit()
                def _cleanup_progress():
                    import time; time.sleep(2)
                    _job_progress.pop(job_id, None)
                threading.Thread(target=_cleanup_progress, daemon=True).start()

    finally:
        _pending_threads.discard(job_id)
        # Release the semaphore only if it hasn't already been released externally by pause_job
        if job_id not in _sem_released:
            sem.release()
        else:
            _sem_released.discard(job_id)


def cancel_job(job_id: int) -> bool:
    process = _running_jobs.get(job_id)
    if process is None:
        return False
    was_paused = job_id in _paused_jobs
    _cancelled_jobs.add(job_id)
    _paused_jobs.discard(job_id)
    _stop_cpulimit(job_id)
    if was_paused:
        # SIGKILL immediately kills stopped processes; SIGTERM is queued and never delivered
        process.kill()
        process.wait()
    else:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    _running_jobs.pop(job_id, None)
    logger.info("Cancelled FFmpeg process for job %d", job_id)
    return True


def pause_job(job_id: int, release_slot: bool = False) -> str | None:
    """SIGSTOP the FFmpeg process.

    release_slot=False (manual pause): holds the semaphore slot — queue does not advance.
    release_slot=True (auto-pause for concurrency reduction): releases the slot so another job can start.

    cpulimit must be stopped before SIGSTOP — cpulimit uses SIGSTOP/SIGCONT itself and
    would race with our pause, potentially resuming the job unexpectedly.
    """
    import signal
    process = _running_jobs.get(job_id)
    if process is None:
        logger.warning("pause_job(%d): not in _running_jobs (tracked: %s)", job_id, list(_running_jobs.keys()))
        return "Job process not found — it may have already finished"
    if job_id in _paused_jobs:
        return "Job is already paused"
    _stop_cpulimit(job_id)
    try:
        os.kill(process.pid, signal.SIGSTOP)
        _paused_jobs.add(job_id)
        if release_slot:
            _sem_released.add(job_id)
            _get_encode_semaphore().release()
            logger.info("Paused job %d (pid %d), released semaphore slot", job_id, process.pid)
        else:
            logger.info("Paused job %d (pid %d), slot retained", job_id, process.pid)
        return None
    except (AttributeError, OSError) as exc:
        logger.warning("Could not pause job %d (pid %d): %s", job_id, process.pid, exc)
        return f"Signal failed: {exc}"


def resume_job(job_id: int) -> str | None:
    """SIGCONT the FFmpeg process, or re-queue a DB-only paused job (was queued when paused).

    If the semaphore slot was released during pause (auto-pause), re-acquires it first
    via a background thread. Manual pauses just send SIGCONT immediately.
    cpulimit is restarted after SIGCONT.
    """
    import signal
    process = _running_jobs.get(job_id)
    if process is None:
        if job_id not in _paused_jobs:
            # DB-only pause: job was queued (no FFmpeg process) when user paused it.
            # The original thread is still blocking on sem.acquire() with _pending_threads tracking it.
            # Just set status back to "queued" — the waiting thread will pick it up when a slot is free.
            with Session(engine) as db:
                job = db.get(EncodeJob, job_id)
                if job and job.status == "paused":
                    job.status = "queued"
                    db.commit()
            logger.info("Resumed DB-only paused job %d (re-queued, thread still waiting for slot)", job_id)
            return None
        logger.warning("resume_job(%d): not in _running_jobs (tracked: %s)", job_id, list(_running_jobs.keys()))
        return "Job process not found"
    if job_id not in _paused_jobs:
        return "Job is not marked as paused"

    if job_id in _sem_released:
        # Slot was released during pause — re-acquire in background (may wait for a free slot)
        def _acquire_and_resume():
            _get_encode_semaphore().acquire()
            if job_id not in _paused_jobs:
                _get_encode_semaphore().release()
                return
            _paused_jobs.discard(job_id)
            _sem_released.discard(job_id)
            try:
                os.kill(process.pid, signal.SIGCONT)
                _start_cpulimit(job_id, process.pid)
                logger.info("Resumed FFmpeg process for job %d (pid %d) after re-acquiring slot", job_id, process.pid)
                with Session(engine) as db:
                    job = db.get(EncodeJob, job_id)
                    if job and job.status == "paused":
                        job.status = "encoding"
                        db.commit()
            except (AttributeError, OSError) as exc:
                _get_encode_semaphore().release()
                logger.warning("Could not resume job %d (pid %d): %s", job_id, process.pid, exc)
        threading.Thread(target=_acquire_and_resume, daemon=True).start()
    else:
        # Slot still held — just unfreeze the process
        try:
            os.kill(process.pid, signal.SIGCONT)
            _paused_jobs.discard(job_id)
            _start_cpulimit(job_id, process.pid)
            logger.info("Resumed FFmpeg process for job %d (pid %d)", job_id, process.pid)
        except (AttributeError, OSError) as exc:
            logger.warning("Could not resume job %d (pid %d): %s", job_id, process.pid, exc)
            return f"Signal failed: {exc}"

    return None


def get_queue_status() -> dict:
    with Session(engine) as db:
        counts: dict = {"queued": 0, "encoding": 0, "paused": 0, "complete": 0, "failed": 0}
        for status in counts:
            counts[status] = db.query(EncodeJob).filter(EncodeJob.status == status).count()
        bytes_saved_row = (
            db.query(
                func.sum(EncodeJob.original_size_bytes - EncodeJob.final_size_bytes)
            )
            .filter(
                EncodeJob.status == "complete",
                EncodeJob.original_size_bytes.isnot(None),
                EncodeJob.final_size_bytes.isnot(None),
                EncodeJob.original_size_bytes > EncodeJob.final_size_bytes,
            )
            .scalar()
        )
        counts["total_bytes_saved"] = max(0, bytes_saved_row or 0)
    return counts
