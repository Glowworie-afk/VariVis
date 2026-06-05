"""
app/api/midi.py
────────────────
Routes: MIDI piano roll and per-variation structural analysis.
"""

import re

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.core.config import ANNOTATION
from app.services.midi import (
    extract_k_number,
    find_midi_file,
    parse_midi_analysis,
)
from app.services.musicxml import get_musicxml_sections

try:
    import mido
except ImportError:
    mido = None  # type: ignore

router = APIRouter()


@router.get("/api/midi/notes/{file_name}")
def get_midi_notes(file_name: str, n_variations: "int | None" = None):
    """Return raw MIDI note list + segment boundaries for piano-roll rendering."""
    midi_path = find_midi_file(file_name)
    if midi_path is None:
        return {"matched": False, "message": f"No MIDI found for '{file_name}'"}

    if mido is None:
        raise HTTPException(500, "mido not installed")

    mid    = mido.MidiFile(str(midi_path))
    tpb    = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    tempo_map: list[tuple[int, int]] = [(0, 500_000)]
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "set_tempo":
            tempo_map.append((abs_t, msg.tempo))

    def tick2beat(t: int) -> float:
        return t / tpb

    raw_notes: list[dict] = []
    active: dict = {}
    abs_t = 0
    beats_per_bar = 4

    for msg in merged:
        abs_t += msg.time
        if msg.type == "time_signature":
            beats_per_bar = msg.numerator
        if msg.type == "note_on" and msg.velocity > 0:
            active[(msg.note, msg.channel)] = (abs_t, msg.velocity)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            key = (msg.note, msg.channel)
            if key in active:
                on_t, vel = active.pop(key)
                dur_ticks  = max(1, abs_t - on_t)
                raw_notes.append({
                    "pitch":     msg.note,
                    "beat":      round(tick2beat(on_t), 4),
                    "dur_beats": round(tick2beat(dur_ticks), 4),
                    "velocity":  vel,
                })

    if not raw_notes:
        raise HTTPException(422, "No notes found in MIDI file")

    raw_notes.sort(key=lambda n: n["beat"])
    total_beats = max(n["beat"] + n["dur_beats"] for n in raw_notes)
    total_bars  = int(total_beats / beats_per_bar) + 1

    def note_bar(n: dict) -> int:
        return int(n["beat"] / beats_per_bar)

    var_labels: list[str] = []
    var_starts: list[int] = []

    mxml_secs = get_musicxml_sections(file_name)
    if mxml_secs:
        var_labels = [s[0] for s in mxml_secs]
        var_starts = [s[1] for s in mxml_secs]

    if not var_labels and n_variations is not None and n_variations >= 1:
        n_segs     = n_variations + 1
        step       = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_variations + 1)]

    k_num = extract_k_number(midi_path.name)
    if not var_labels and k_num and ANNOTATION.exists():
        try:
            ann = pd.read_excel(ANNOTATION)
            pat = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
            rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
            if not rows.empty:
                row     = rows.iloc[0]
                raw_lbl = str(row.get("label", "")).strip().strip("[]").replace("'", "").replace('"', "")
                lbl_list = [s.strip() for s in raw_lbl.split(",") if s.strip()]

                def _nl(l: str) -> str:
                    if l in ("T", "Theme"): return "Theme"
                    if l in ("C", "Coda"):  return "Coda"
                    m2 = re.match(r"V(\d+)", l, re.IGNORECASE)
                    return f"Var.{int(m2.group(1)):02d}" if m2 else l

                lbl_list = [_nl(l) for l in lbl_list]
                if len(lbl_list) >= 2:
                    step       = total_bars / len(lbl_list)
                    var_starts = [round(i * step) for i in range(len(lbl_list))]
                    var_labels = lbl_list
        except Exception:
            pass

    if not var_labels:
        theme_bars = 16; var_bars = 16
        var_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, 13)]
        var_starts = [0] + [theme_bars + i * var_bars for i in range(12)]

    var_ends = var_starts[1:] + [total_bars]

    segments = []
    for i, (label, bar_s, bar_e) in enumerate(zip(var_labels, var_starts, var_ends)):
        segments.append({
            "idx":        i,
            "label":      label,
            "beat_start": round(bar_s * beats_per_bar, 2),
            "beat_end":   round(min(bar_e * beats_per_bar, total_beats), 2),
        })

    seg_beat_starts = [s["beat_start"] for s in segments]
    for n in raw_notes:
        seg_idx = 0
        for k, bs in enumerate(seg_beat_starts):
            if n["beat"] >= bs:
                seg_idx = k
        n["seg"] = seg_idx

    avg_tempo_us = tempo_map[-1][1] if len(tempo_map) > 1 else tempo_map[0][1]
    tempo_bpm    = round(60_000_000 / avg_tempo_us, 2)

    return {
        "matched":       True,
        "file_name":     file_name,
        "beats_per_bar": beats_per_bar,
        "total_beats":   round(total_beats, 2),
        "total_bars":    total_bars,
        "tempo_bpm":     tempo_bpm,
        "segments":      segments,
        "notes":         raw_notes,
    }


@router.get("/api/midi/{file_name}")
def get_midi_analysis(file_name: str, n_variations: "int | None" = None):
    """Fuzzy-match file_name → TV_MIDI/, return per-variation structural analysis."""
    midi_path = find_midi_file(file_name)
    if midi_path is None:
        return {
            "matched":   False,
            "file_name": file_name,
            "message":   f"No matching MIDI found for '{file_name}' in TV_MIDI/",
        }
    try:
        result = parse_midi_analysis(midi_path, n_variations=n_variations)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    result["file_name"] = file_name
    return result
