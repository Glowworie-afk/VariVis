"""
app/main.py
────────────
FastAPI application factory.

Usage (from backend/):
    uvicorn app.main:app --reload --port 8000
"""

import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import midi, musicvis, pieces, score, symbolic, upload
from app.core.config import IMSLP_DIR, MUSICXML_DIR, TEMP_FEATURE_DIR

_TEMP_TTL_SECONDS = 24 * 3600   # delete temp files older than 24 hours
_CLEANUP_INTERVAL = 3600         # run cleanup every hour


def _purge_old_temp_files() -> int:
    """Delete temp_* files older than TTL from all three temp locations.
    Returns the number of files deleted."""
    cutoff = time.time() - _TEMP_TTL_SECONDS
    deleted = 0
    dirs_and_patterns = [
        (TEMP_FEATURE_DIR, "temp_*.json"),
        (MUSICXML_DIR,     "temp_*.mxl"),
        (MUSICXML_DIR,     "temp_*.xml"),
        (MUSICXML_DIR,     "temp_*.musicxml"),
        (IMSLP_DIR,        "temp_*.pdf"),
    ]
    for directory, pattern in dirs_and_patterns:
        if not directory.exists():
            continue
        for path in directory.glob(pattern):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
                    deleted += 1
            except OSError:
                pass
    return deleted


async def _cleanup_loop():
    while True:
        await asyncio.sleep(_CLEANUP_INTERVAL)
        n = _purge_old_temp_files()
        if n:
            print(f"[cleanup] Purged {n} expired temp file(s).")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: clean up leftover temp files from previous runs
    n = _purge_old_temp_files()
    if n:
        print(f"[startup] Purged {n} expired temp file(s) on startup.")

    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()


app = FastAPI(title="VariVis API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pieces.router)
app.include_router(score.router)
app.include_router(musicvis.router)
app.include_router(midi.router)
app.include_router(symbolic.router)
app.include_router(upload.router)
