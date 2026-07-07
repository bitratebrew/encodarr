# Entry point for the encodarr application.
# Initializes the web server, loads configuration, and wires together
# the scanner, encoder, and API components.

import logging
import os
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware

from api.routes import router
from auth import SESSION_COOKIE, verify_session_token
from database import EncodeJob, MediaCandidate, MediaLibrary, Session, engine, init_db
from encoder import detect_hardware_encoders
from scanner import scan_library
from scheduler import start_scheduler, stop_scheduler
from settings import get_setting, init_secret_key, seed_default_settings, set_setting

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(message)s",
)

logger = logging.getLogger(__name__)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "templates")

templates = Jinja2Templates(directory=TEMPLATES_DIR)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing database")
    init_db()
    seed_default_settings()
    init_secret_key()

    # Bootstrap credentials from env vars on first run (only if no hash stored yet)
    initial_password = os.environ.get("ENCODARR_PASSWORD")
    if initial_password and not get_setting("auth_password_hash"):
        from auth import hash_password
        set_setting("auth_username", os.environ.get("ENCODARR_USERNAME", "admin"))
        set_setting("auth_password_hash", hash_password(initial_password))
        logger.info("Auth enabled via ENCODARR_PASSWORD env var")

    detect_hardware_encoders()

    with Session(engine) as db:
        interrupted_jobs = db.query(EncodeJob).filter(EncodeJob.status.in_(["encoding", "paused"])).all()
        for job in interrupted_jobs:
            job.status = "failed"
            job.error_message = "Job interrupted — container was stopped mid-encode"
        db.query(MediaCandidate).filter(MediaCandidate.status == "encoding").update(
            {"status": "pending"}, synchronize_session=False
        )
        db.commit()
        if interrupted_jobs:
            logger.warning("Reset %d interrupted/paused encoding job(s) to failed", len(interrupted_jobs))

    transcode_path = os.environ.get("TRANSCODE_PATH", "/transcode")
    if os.path.isdir(transcode_path):
        stale = list(Path(transcode_path).glob("*.tmp.*"))
        for f in stale:
            try:
                f.unlink()
            except OSError as e:
                logger.warning("Could not delete stale transcode file %s: %s", f, e)
        if stale:
            logger.info("Cleaned up %d stale transcode file(s) from %s", len(stale), transcode_path)

    # Start scheduler thread
    start_scheduler()

    yield

    # Stop scheduler thread
    stop_scheduler()


_AUTH_PUBLIC = {"/login", "/icon.svg", "/api/auth/login", "/api/auth/status"}
_AUTH_PUBLIC_PREFIXES = ("/static/",)


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not get_setting("auth_password_hash"):
            return await call_next(request)
        path = request.url.path
        if path in _AUTH_PUBLIC or any(path.startswith(p) for p in _AUTH_PUBLIC_PREFIXES):
            return await call_next(request)
        token = request.cookies.get(SESSION_COOKIE)
        if token and verify_session_token(token):
            return await call_next(request)
        if path.startswith("/api/"):
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)
        return RedirectResponse("/login")


app = FastAPI(title="Encodarr", version="0.1.0", lifespan=lifespan)

app.add_middleware(AuthMiddleware)
app.include_router(router)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/login")
def login_page(request: Request, error: str = ""):
    return templates.TemplateResponse(request, "login.html", {"error": error})


@app.get("/icon.svg")
def get_icon():
    icon_path = os.path.join(STATIC_DIR, "icon.svg")
    return FileResponse(icon_path, media_type="image/svg+xml")


@app.get("/{full_path:path}")
def spa_fallback(request: Request, full_path: str):
    return templates.TemplateResponse(
        request,
        "base.html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )
