import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from datetime import time as dtime

from auto_approve import evaluate_auto_approve
from scanner import scan_library
from settings import clear_governor_overrides, get_setting, set_governor_overrides

logger = logging.getLogger(__name__)

# Scheduled scan state
last_scheduled_scan_time = None
scheduler_thread = None
scheduler_stop_event = threading.Event()

_active_window_id: int | None = None


def get_scheduled_scan_info():
    """Return last and next scheduled scan times."""
    interval_hours = int(get_setting("scan_schedule_interval_hours", "24"))
    next_scan = None
    if last_scheduled_scan_time:
        next_scan = last_scheduled_scan_time + timedelta(hours=interval_hours)
    return {
        "last_scheduled_scan": last_scheduled_scan_time.isoformat() if last_scheduled_scan_time else None,
        "next_scheduled_scan": next_scan.isoformat() if next_scan else None,
    }


def _time_in_window(start: str, end: str, now_t: dtime) -> bool:
    """True if now_t falls in [start, end), supporting midnight crossover."""
    s = dtime.fromisoformat(start)
    e = dtime.fromisoformat(end)
    if s <= e:
        return s <= now_t < e
    # midnight crossover e.g. 23:00 – 02:00
    return now_t >= s or now_t < e


def _check_governor_windows() -> None:
    global _active_window_id
    from database import ScheduledGovernor, Session, engine
    from encoder import dispatch_queued_jobs, reset_encode_semaphore

    now_t = datetime.now().time().replace(second=0, microsecond=0)

    with Session(engine) as db:
        windows = db.query(ScheduledGovernor).filter_by(enabled=True).all()
        active = next((w for w in windows if _time_in_window(w.start_time, w.end_time, now_t)), None)
        if active:
            active_id = active.id
            overrides = {
                "encode_cpu_limit_percent": active.cpu_limit,
                "max_concurrent_encodes": active.max_concurrent,
            }
            label = active.label or f"Window {active.id}"

    if active:
        if _active_window_id != active_id:
            _active_window_id = active_id
            set_governor_overrides(overrides)
            reset_encode_semaphore()
            dispatch_queued_jobs()
            logger.info("Governor window '%s' activated: cpu=%d%% concurrent=%d",
                        label, overrides["encode_cpu_limit_percent"],
                        overrides["max_concurrent_encodes"])
    else:
        if _active_window_id is not None:
            prev_id = _active_window_id
            _active_window_id = None
            clear_governor_overrides()
            reset_encode_semaphore()
            dispatch_queued_jobs()
            logger.info("Governor window %d deactivated — settings restored", prev_id)


def scheduler_loop():
    """Background thread that checks every minute for scheduled scans and governor windows."""
    global last_scheduled_scan_time

    while not scheduler_stop_event.is_set():
        try:
            enabled = get_setting("scan_schedule_enabled", "false").lower() == "true"
            interval_hours = int(get_setting("scan_schedule_interval_hours", "24"))

            if enabled:
                now = datetime.now(timezone.utc)
                should_scan = False

                if last_scheduled_scan_time is None:
                    should_scan = True
                    logger.info("Scheduled scan: first run, executing scan")
                else:
                    time_since_last = now - last_scheduled_scan_time
                    if time_since_last >= timedelta(hours=interval_hours):
                        should_scan = True
                        logger.info("Scheduled scan: %d hours elapsed, executing scan", interval_hours)

                if should_scan:
                    logger.info("Running scheduled library scan")
                    scan_library()
                    last_scheduled_scan_time = datetime.now(timezone.utc)
                    evaluate_auto_approve()

            _check_governor_windows()

        except Exception as e:
            logger.error("Error in scheduler loop: %s", e)

        # Sleep 60s — governor windows need minute-level resolution; scan timing is by elapsed time
        for _ in range(60):
            if scheduler_stop_event.is_set():
                break
            time.sleep(1)

    logger.info("Scheduler thread stopped")


def start_scheduler():
    """Start the scheduler background thread."""
    global scheduler_thread
    scheduler_stop_event.clear()
    scheduler_thread = threading.Thread(target=scheduler_loop, daemon=True, name="scheduler")
    scheduler_thread.start()
    logger.info("Started scheduled scan thread")


def stop_scheduler():
    """Stop the scheduler background thread."""
    scheduler_stop_event.set()
    if scheduler_thread and scheduler_thread.is_alive():
        scheduler_thread.join(timeout=5)
        logger.info("Stopped scheduled scan thread")
