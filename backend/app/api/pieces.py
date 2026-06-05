"""
app/api/pieces.py
──────────────────
Routes: piece catalogue, feature serving, audio serving.
"""

import json

import pandas as pd
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.core.config import ANNOTATION, AUDIO_DIR, FEATURE_DIR
from app.services.midi import find_midi_file

router = APIRouter()


@router.get("/api/pieces")
def list_pieces():
    if not ANNOTATION.exists():
        raise HTTPException(500, "TV_annotation.xlsx not found in backend/data/")

    df = pd.read_excel(ANNOTATION)
    df["folder"] = df["folder"].ffill()

    col = "file_name (folderName_number)"
    results = []
    for _, row in df.iterrows():
        name = str(row.get(col, "")).strip()
        if not name or name == "nan":
            continue
        has_midi = find_midi_file(name) is not None
        results.append({
            "file_name":  name,
            "music_name": str(row.get("music_name", "")),
            "composer":   str(row.get("composer",   "")),
            "instrument": str(row.get("instrument", "")),
            "period":     str(row.get("period",     "")),
            "folder":     str(row.get("folder",     "")),
            "extracted":  (FEATURE_DIR / f"{name}.json").exists(),
            "has_midi":   has_midi,
        })
    return results


@router.get("/api/features/{file_name}")
def get_features(file_name: str):
    path = FEATURE_DIR / f"{file_name}.json"
    if not path.exists():
        raise HTTPException(404, f"Features not found for '{file_name}'. Run extraction first.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@router.get("/api/audio/{file_name}")
def get_audio(file_name: str, folder: str = ""):
    if folder:
        path = AUDIO_DIR / folder / f"{file_name}.wav"
        if path.exists():
            return FileResponse(str(path), media_type="audio/wav",
                                headers={"Accept-Ranges": "bytes"})

    if AUDIO_DIR.exists():
        for d in AUDIO_DIR.iterdir():
            if d.is_dir():
                path = d / f"{file_name}.wav"
                if path.exists():
                    return FileResponse(str(path), media_type="audio/wav",
                                        headers={"Accept-Ranges": "bytes"})

    raise HTTPException(404, f"Audio file not found: {file_name}.wav")
