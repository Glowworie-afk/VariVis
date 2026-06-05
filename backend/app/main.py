"""
app/main.py
────────────
FastAPI application factory.

Usage (from backend/):
    uvicorn app.main:app --reload --port 8000
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import midi, musicvis, pieces, score, symbolic, upload

app = FastAPI(title="VariVis API")

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
