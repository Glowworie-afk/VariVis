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

# Data directories (external datasets — not checked into git)
AUDIO_DIR    = BASE_DIR / "TV_dataset_audio"
MIDI_DIR     = BASE_DIR / "TV_MIDI"
IMSLP_DIR    = BASE_DIR / "IMSLP"
MUSICXML_DIR = BASE_DIR / "MusicXML"

# Backend data
FEATURE_DIR      = BACKEND_DIR / "features"
TEMP_FEATURE_DIR = FEATURE_DIR / "temp"
DATA_DIR         = BACKEND_DIR / "data"
ANNOTATION       = DATA_DIR / "TV_annotation.xlsx"

# Ensure writable dirs exist at import time
FEATURE_DIR.mkdir(exist_ok=True)
TEMP_FEATURE_DIR.mkdir(exist_ok=True)
MUSICXML_DIR.mkdir(exist_ok=True)
