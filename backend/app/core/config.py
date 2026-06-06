"""
app/core/config.py
──────────────────
All filesystem path constants for the VariVis backend.
Import from here instead of redefining Path(__file__).parent chains in each module.
"""

from pathlib import Path

# backend/  (this file lives at backend/app/core/config.py)
BACKEND_DIR  = Path(__file__).parent.parent.parent

# VariVis/  (project root)
BASE_DIR     = BACKEND_DIR.parent

# Backend data
DATA_DIR         = BACKEND_DIR / "data"
FEATURE_DIR      = BACKEND_DIR / "features"
TEMP_FEATURE_DIR = FEATURE_DIR / "temp"
ANNOTATION       = DATA_DIR / "TV_annotation.xlsx"

# Data directories (external datasets — not checked into git)
AUDIO_DIR    = BASE_DIR / "TV_dataset_audio"
MIDI_DIR     = DATA_DIR / "TV_MIDI"
IMSLP_DIR    = DATA_DIR / "IMSLP"
MUSICXML_DIR = DATA_DIR / "MusicXML"
SCORES_DIR   = DATA_DIR / "scores"

# Ensure writable dirs exist at import time
FEATURE_DIR.mkdir(exist_ok=True)
TEMP_FEATURE_DIR.mkdir(exist_ok=True)
MUSICXML_DIR.mkdir(exist_ok=True)
SCORES_DIR.mkdir(exist_ok=True)
