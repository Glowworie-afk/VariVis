"""
app/api/pieces.py
──────────────────
Routes: piece catalogue, feature serving, audio serving, SSE extraction.
"""

import asyncio
import json
import sys
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse

from app.core.config import ANNOTATION, AUDIO_DIR, BACKEND_DIR, FEATURE_DIR
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


@router.get("/api/extract/{file_name}")
async def extract_stream(file_name: str):
    """SSE endpoint: run extract_features.py then add_pitch_contour.py."""

    async def stream():
        yield "data: STEP:extract\n\n"
        proc1 = await asyncio.create_subprocess_exec(
            sys.executable, "extract_features.py", file_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(BACKEND_DIR),
        )
        async for raw in proc1.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                yield f"data: {line}\n\n"
        await proc1.wait()

        if proc1.returncode != 0:
            yield f"data: ERROR:extract_features.py exited with code {proc1.returncode}\n\n"
            return

        yield "data: STEP:pyin\n\n"
        proc2 = await asyncio.create_subprocess_exec(
            sys.executable, "add_pitch_contour.py", file_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(BACKEND_DIR),
        )
        async for raw in proc2.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                yield f"data: {line}\n\n"
        await proc2.wait()

        if proc2.returncode != 0:
            yield f"data: ERROR:add_pitch_contour.py exited with code {proc2.returncode}\n\n"
            return

        yield "data: DONE\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
