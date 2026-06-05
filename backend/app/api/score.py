"""
app/api/score.py
─────────────────
Routes: PDF score serving, MusicXML serving, MXL note extraction.
"""

import pandas as pd
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from app.core.config import ANNOTATION, MUSICXML_DIR
from app.services.midi import find_midi_file
from app.services.musicxml import (
    _SCORE_MAP,
    extract_mxl,
    find_local_score,
    find_musicxml,
    get_musicxml_sections,
    score_cache_path,
)
from app.services.score_matching import best_imslp_match

router = APIRouter()


@router.get("/api/score/pdf/{file_name}")
def get_score_pdf(file_name: str):
    music_name = ""
    try:
        df  = pd.read_excel(ANNOTATION)
        df["folder"] = df["folder"].ffill()
        col = "file_name (folderName_number)"
        row = df[df[col] == file_name]
        if not row.empty:
            music_name = str(row.iloc[0].get("music_name", ""))
    except Exception:
        pass

    from app.core.config import IMSLP_DIR
    best, score, pdfs = best_imslp_match(file_name, music_name)

    if best is None or score < 0.3:
        raise HTTPException(
            404,
            detail={
                "matched":   False,
                "file_name": file_name,
                "message":   "No matching PDF found in IMSLP/",
                "available": pdfs,
            },
        )

    pdf_path = IMSLP_DIR / best
    return FileResponse(
        str(pdf_path),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{best}"',
            "X-Match-Score":       str(score),
            "X-Matched-File":      best,
        },
    )


@router.get("/api/score/match")
def match_score(file_name: str = "", music_name: str = ""):
    best, score, pdfs = best_imslp_match(file_name, music_name)
    return {"matched": best is not None, "pdf_name": best, "score": score, "available": pdfs}


@router.get("/api/score/musicxml/{file_name}")
def get_musicxml(file_name: str):
    """
    Serve MusicXML for a piece.  Priority:
      1. scores/<stem>.cached.xml  — previously converted
      2. scores/<stem>.mxl/.xml    — user-placed IMSLP file
      3. TV_MIDI/<matched>.mid     — MIDI → MusicXML via music21
    """
    import re
    import music21

    cache = score_cache_path(file_name)

    if cache.exists():
        return {
            "matched":   True,
            "source":    "cache",
            "file_name": file_name,
            "xml":       cache.read_text(encoding="utf-8"),
        }

    local = find_local_score(file_name)
    if local is not None:
        try:
            score    = music21.converter.parse(str(local))
            exporter = music21.musicxml.m21ToXml.GeneralObjectExporter(score)
            xml_str  = exporter.parse().decode("utf-8", errors="replace")
            cache.write_text(xml_str, encoding="utf-8")
            return {"matched": True, "source": f"imslp:{local.name}",
                    "file_name": file_name, "xml": xml_str}
        except Exception as e:
            raise HTTPException(500, f"music21 parse failed for {local.name}: {e}")

    midi_path = find_midi_file(file_name)
    if midi_path is not None:
        try:
            score    = music21.converter.parse(str(midi_path))
            exporter = music21.musicxml.m21ToXml.GeneralObjectExporter(score)
            xml_str  = exporter.parse().decode("utf-8", errors="replace")
            cache.write_text(xml_str, encoding="utf-8")
            return {"matched": True, "source": f"midi:{midi_path.name}",
                    "file_name": file_name, "xml": xml_str}
        except Exception as e:
            raise HTTPException(500, f"music21 MIDI conversion failed: {e}")

    base = re.sub(r"_\d+$", "", file_name)
    stem = _SCORE_MAP.get(base)
    return {
        "matched":       False,
        "file_name":     file_name,
        "expected_file": f"scores/{stem}.mxl" if stem else None,
        "message": (
            f"No score found. Place the MusicXML file at scores/{stem}.mxl"
            if stem else
            f"'{file_name}' is not in the score map."
        ),
    }


@router.get("/api/score/mxl_notes/{file_name}")
def get_mxl_notes(file_name: str):
    """Extract notes from MusicXML for in-browser Tone.js synthesis."""
    path = find_musicxml(file_name)
    if path is None:
        return {"available": False}

    try:
        import music21
    except ImportError:
        return {"available": False}

    try:
        if path.suffix.lower() == ".mxl":
            score = music21.converter.parseData(extract_mxl(path), format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception as e:
        return {"available": False, "error": str(e)}

    tempo_bpm = 120.0
    for el in score.flatten():
        if isinstance(el, music21.tempo.MetronomeMark) and el.number:
            tempo_bpm = float(el.number)
            break
    sec_per_qn = 60.0 / tempo_bpm

    raw_notes: list[dict] = []
    for part in score.parts:
        for el in part.flatten().notesAndRests:
            if isinstance(el, music21.note.Rest):
                continue
            pitches = el.pitches if isinstance(el, music21.chord.Chord) else [el.pitch]
            vel = int(getattr(el, "volume", None) and el.volume.velocity or 64)
            for p in pitches:
                raw_notes.append({
                    "pitch":     p.midi,
                    "start_sec": round(float(el.offset) * sec_per_qn, 4),
                    "dur_sec":   round(float(el.duration.quarterLength) * sec_per_qn, 4),
                    "velocity":  vel,
                })
    raw_notes.sort(key=lambda n: n["start_sec"])

    mxml_secs = get_musicxml_sections(file_name)
    segments: list[dict] = []

    if mxml_secs:
        part0    = score.parts[0] if score.parts else None
        measures = list(part0.getElementsByClass("Measure")) if part0 else []
        idx_to_qn: dict[int, float] = {mi: float(m.offset)
                                        for mi, m in enumerate(measures)}
        total_dur_sec = max(
            (n["start_sec"] + n["dur_sec"] for n in raw_notes), default=0.0
        )
        for si, (label, m_idx) in enumerate(mxml_secs):
            start_qn  = idx_to_qn.get(m_idx, 0.0)
            start_sec = round(start_qn * sec_per_qn, 3)
            if si + 1 < len(mxml_secs):
                end_sec = round(idx_to_qn.get(mxml_secs[si + 1][1], start_qn) * sec_per_qn, 3)
            else:
                end_sec = round(total_dur_sec, 3)
            segments.append({"label": label, "start_sec": start_sec, "end_sec": end_sec})
    else:
        total_dur_sec = max(
            (n["start_sec"] + n["dur_sec"] for n in raw_notes), default=0.0
        )
        segments = [{"label": "Full", "start_sec": 0.0,
                     "end_sec": round(total_dur_sec, 3)}]

    return {"available": True, "tempo_bpm": round(tempo_bpm, 2),
            "notes": raw_notes, "segments": segments}
