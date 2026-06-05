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

from app.core.config import FEATURE_DIR
from app.services.midi import find_midi_file
from app.services.musicxml import extract_mxl, find_musicxml, get_musicxml_sections
from app.services.symbolic import (
    SYMBOLIC_FEATURE_DEFS,
    compute_distributions,
    compute_symbolic_features,
    parse_mxl_symbolic,
)

try:
    import mido
except ImportError:
    mido = None  # type: ignore

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
    feat_path = FEATURE_DIR / f"{file_name}.json"
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

    if mido is None:
        raise HTTPException(500, "mido not installed — run: pip install mido")

    mid    = mido.MidiFile(str(midi_path))
    tpb    = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    tempo_map: list[tuple[int, int]] = [(0, 500_000)]
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "set_tempo":
            tempo_map.append((abs_t, msg.tempo))

    def tick2sec(tick: int) -> float:
        sec = 0.0
        for i, (t0, tmpo) in enumerate(tempo_map):
            t1  = tempo_map[i + 1][0] if i + 1 < len(tempo_map) else tick
            seg = min(t1, tick)
            sec += (seg - t0) * tmpo / 1_000_000 / tpb
            if seg >= tick:
                break
        return sec

    all_notes: list[dict] = []
    active: dict = {}
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            active[(msg.note, msg.channel)] = abs_t
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            key = (msg.note, msg.channel)
            if key in active:
                on_tick = active.pop(key)
                on_sec  = tick2sec(on_tick)
                off_sec = tick2sec(abs_t)
                all_notes.append({
                    "pitch":     msg.note,
                    "start_sec": on_sec,
                    "dur_sec":   max(off_sec - on_sec, 1e-6),
                })

    if not all_notes:
        raise HTTPException(422, "No notes found in MIDI file")

    # Override segments with score-based boundaries when available
    mxl_path = find_musicxml(file_name)
    if mxl_path is not None:
        try:
            import music21 as _m21
            if mxl_path.suffix.lower() == ".mxl":
                _score = _m21.converter.parseData(extract_mxl(mxl_path), format="musicxml")
            else:
                _score = _m21.converter.parse(str(mxl_path))

            _sections = get_musicxml_sections(file_name)

            if _sections and _score.parts:
                _part     = _score.parts[0]
                _measures = list(_part.getElementsByClass("Measure"))

                def _measure_qn(idx: int) -> float:
                    if idx < len(_measures):
                        return float(_measures[idx].offset)
                    last = _measures[-1]
                    return float(last.offset) + float(last.duration.quarterLength)

                _total_qn = _measure_qn(len(_measures))

                def _qn_to_sec(qn: float) -> float:
                    return tick2sec(int(round(qn * tpb)))

                _score_segs: list[dict] = []
                for _i, (_lbl, _midx) in enumerate(_sections):
                    if _lbl == "Coda":
                        continue
                    _start_qn = _measure_qn(_midx)
                    _end_qn: "float | None" = None
                    for _j in range(_i + 1, len(_sections)):
                        _nl, _nm = _sections[_j]
                        if _nl != "Coda":
                            _end_qn = _measure_qn(_nm)
                            break
                    if _end_qn is None:
                        _end_qn = _total_qn

                    _score_segs.append({
                        "label":     _lbl,
                        "start_sec": _qn_to_sec(_start_qn),
                        "end_sec":   _qn_to_sec(_end_qn),
                    })

                if _score_segs:
                    segments_meta = _score_segs
        except Exception:
            pass

    result_segments = []
    for sm in segments_meta:
        seg_start = sm["start_sec"]
        seg_end   = sm["end_sec"]
        seg_dur   = max(seg_end - seg_start, 1e-6)

        seg_notes = [n for n in all_notes if seg_start <= n["start_sec"] < seg_end]

        feats = compute_symbolic_features(seg_notes, seg_dur)
        dists = compute_distributions(seg_notes)
        result_segments.append({
            "label":         sm["label"],
            "n_notes":       len(seg_notes),
            "features":      feats,
            "distributions": dists,
        })

    return {
        "matched":      True,
        "file_name":    file_name,
        "source":       "midi",
        "midi_name":    midi_path.name,
        "segments":     result_segments,
        "feature_defs": feature_defs_out,
    }
