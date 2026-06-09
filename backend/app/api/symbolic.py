"""
app/api/symbolic.py
────────────────────
Route: symbolic music feature extraction per segment.

Priority:
  1. MusicXML  — segment by Rehearsal Mark, notes from score
  2. MIDI      — segment by audio annotation timestamps (fallback)
"""

import json
import re

from fastapi import APIRouter, HTTPException

from app.core.config import FEATURE_DIR, TEMP_FEATURE_DIR
from app.services.midi import find_midi_file
from app.services.symbolic import (
    SYMBOLIC_FEATURE_DEFS,
    compute_distributions,
    compute_symbolic_features,
    compute_symbolic_midi_fallback,
    parse_mxl_symbolic,
)

router = APIRouter()


@router.get("/api/symbolic/{file_name}")
def get_symbolic_features(file_name: str):
    feature_defs_out = [
        {"key": k, "label_zh": zh, "label_en": en, "cat": cat, "chart_type": ct}
        for k, zh, en, cat, ct in SYMBOLIC_FEATURE_DEFS
    ]

    # ── 1. Try MusicXML ────────────────────────────────────────────────
    piece_stem   = re.sub(r"_\d+$", "", file_name)
    mxl_sections = parse_mxl_symbolic(piece_stem)

    if mxl_sections is not None:
        result_segments = []
        for sec in mxl_sections:
            if sec["label"] == "C":
                continue
            notes = sec["notes_sec"]
            feats = compute_symbolic_features(notes, sec["seg_dur_sec"])
            dists = compute_distributions(notes)
            result_segments.append({
                "label":         sec["label"],
                "n_notes":       len(notes),
                "features":      feats,
                "distributions": dists,
            })

        if result_segments:
            return {
                "matched":      True,
                "file_name":    file_name,
                "source":       "musicxml",
                "midi_name":    f"{piece_stem}.mxl",
                "segments":     result_segments,
                "feature_defs": feature_defs_out,
            }

    # ── 2. Graceful no-data for temp uploads ───────────────────────────
    if piece_stem.startswith("temp_"):
        return {
            "matched":      False,
            "file_name":    file_name,
            "source":       "none",
            "segments":     [],
            "feature_defs": feature_defs_out,
            "message": (
                "MusicXML has no detectable section structure "
                "(no rehearsal marks / section labels found)."
            ),
        }

    # ── 3. Fallback: MIDI + audio timestamps ───────────────────────────
    feat_dir  = TEMP_FEATURE_DIR if piece_stem.startswith("temp_") else FEATURE_DIR
    feat_path = feat_dir / f"{file_name}.json"
    if not feat_path.exists():
        raise HTTPException(
            404,
            f"Feature file not found for '{file_name}'. "
            "Please extract audio features first."
        )
    with open(feat_path, encoding="utf-8") as fh:
        feat_data = json.load(fh)

    segments_meta = [
        {
            "label":     s["label"],
            "start_sec": float(s.get("start_sec", 0)),
            "end_sec":   float(s.get("end_sec", 0)),
        }
        for s in feat_data.get("segments", [])
        if s.get("label", "C") != "C"
    ]
    if not segments_meta:
        raise HTTPException(422, f"No segments found in feature file for '{file_name}'")

    midi_path = find_midi_file(file_name)
    if midi_path is None:
        raise HTTPException(
            404,
            f"No MIDI file found for '{file_name}'. "
            "Check that TV_MIDI/ contains a matching .mid file."
        )

    try:
        result_segments = compute_symbolic_midi_fallback(file_name, segments_meta, midi_path)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))

    return {
        "matched":      True,
        "file_name":    file_name,
        "source":       "midi",
        "midi_name":    midi_path.name,
        "segments":     result_segments,
        "feature_defs": feature_defs_out,
    }
