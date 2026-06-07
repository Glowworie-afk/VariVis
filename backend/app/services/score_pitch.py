"""
app/services/score_pitch.py
────────────────────────────
Score-based pitch contour extraction from MusicXML (via music21).

Produces score_beat_midi_relative — the highest-priority pitch contour source,
shared across all performer versions of the same piece since it comes from the
composition itself, not the audio recording.

Used by:
  - api/upload.py  (calls build_score_contours directly for uploaded MXL)
"""

import re
import zipfile
from pathlib import Path

import numpy as np

from app.core.config import MUSICXML_DIR

CHROMA_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

TEMPERLEY_MAJOR = np.array([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0])
TEMPERLEY_MINOR = np.array([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0])

_ROMAN = {"i":1,"ii":2,"iii":3,"iv":4,"v":5,"vi":6,
          "vii":7,"viii":8,"ix":9,"x":10,"xi":11,"xii":12}

_SKIP = ("m.s.", "m.d.", "destra", "sinistra", "ritard", "fine", "segue",
         "rit.", "poco", "sempre", "cresc", "decresc", "dim.", "sfz", "fz",
         "dolce", "legato", "staccato", "andantino", "andante",
         "allegro", "adagio", "moderato", "presto", "vivace", "largo", "lento")


# ── Helpers ───────────────────────────────────────────────────────────────────

def label_key(label: str) -> int:
    """Map any section label to a sortable integer (0=Theme, 1-12=Var, 999=Coda)."""
    low = label.strip().lower()
    if low in ("t", "theme", "thema", "tema"):
        return 0
    if low in ("c", "coda", "finale"):
        return 999
    m = re.search(r"(\d+)", label)
    if m:
        return int(m.group(1))
    m2 = re.search(r"[.\s]+([IVXivx]+)\s*$", label)
    if m2:
        n = _ROMAN.get(m2.group(1).strip().lower())
        if n:
            return n
    return 998


def _detect_key(pc_counts: np.ndarray) -> dict:
    chroma   = pc_counts.astype(float)
    if chroma.sum() < 1e-9:
        chroma = np.ones(12)
    best_r, best_tonic, best_major = -np.inf, 0, True
    for tonic in range(12):
        r_maj = float(np.corrcoef(chroma, np.roll(TEMPERLEY_MAJOR, tonic))[0, 1])
        r_min = float(np.corrcoef(chroma, np.roll(TEMPERLEY_MINOR, tonic))[0, 1])
        r_maj = r_maj if np.isfinite(r_maj) else -1.0
        r_min = r_min if np.isfinite(r_min) else -1.0
        if r_maj > best_r:
            best_r, best_tonic, best_major = r_maj, tonic, True
        if r_min > best_r:
            best_r, best_tonic, best_major = r_min, tonic, False
    return {
        "score_tonic_semitone":  best_tonic,
        "score_tonic_name":      CHROMA_NAMES[best_tonic],
        "score_is_major":        best_major,
        "score_key_correlation": round(float(best_r), 4),
    }


def _to_relative(midi_vals: list, tonic: int) -> list:
    if not midi_vals:
        return []
    arr       = np.array(midi_vals, dtype=float)
    med       = float(np.nanmedian(arr))
    tonic_ref = round((med - tonic) / 12) * 12 + tonic
    return [round(float(v) - tonic_ref, 2) for v in midi_vals]


def _find_mxl(piece_stem: str) -> "Path | None":
    for ext in (".mxl", ".xml", ".musicxml"):
        p = MUSICXML_DIR / f"{piece_stem}{ext}"
        if p.exists():
            return p
    return None


def _read_mxl_bytes(path: Path) -> bytes:
    if path.suffix.lower() == ".mxl":
        with zipfile.ZipFile(path, "r") as z:
            xml_name = next(
                (n for n in z.namelist() if n.endswith(".xml") and "META" not in n.upper()),
                None,
            )
            if xml_name is None:
                raise ValueError("No XML inside .mxl")
            return z.read(xml_name)
    return path.read_bytes()


# ── Core ─────────────────────────────────────────────────────────────────────

def build_score_contours(piece_stem: str) -> "dict[int, dict] | None":
    """
    Parse MusicXML and extract highest-note-per-beat per section.
    Returns {label_key: pitch_contour_dict} or None if MusicXML unavailable.
    """
    path = _find_mxl(piece_stem)
    if path is None:
        return None
    try:
        import music21
        score = music21.converter.parseData(_read_mxl_bytes(path), format="musicxml")
    except Exception as e:
        print(f"  music21 parse error: {e}")
        return None

    if not score.parts:
        return None

    all_notes: list[dict] = []
    for part in score.parts:
        for el in part.flatten().notes:
            pitches  = [el.pitch.midi] if hasattr(el, "pitch") else [p.midi for p in el.pitches]
            duration = float(el.duration.quarterLength)
            for midi in pitches:
                all_notes.append({"offset": float(el.offset), "pitch": midi, "duration": duration})
    all_notes.sort(key=lambda n: n["offset"])
    if not all_notes:
        return None

    part0   = score.parts[0]
    measures = list(part0.getElementsByClass("Measure"))

    raw_sections: list[tuple[float, str]] = []
    seen_off: set[float] = set()
    for m in measures:
        off = float(m.offset)
        if off in seen_off:
            continue
        seen_off.add(off)
        for el in m.flatten():
            if isinstance(el, (music21.expressions.RehearsalMark,
                                music21.expressions.TextExpression)):
                content = (el.content if hasattr(el, "content") else str(el)).strip()
                if not content:
                    continue
                low = content.lower()
                if any(k in low for k in _SKIP):
                    continue
                if low.startswith(("tema","var","theme","coda","finale","minore",
                                   "maggiore","trio","thema")):
                    raw_sections.append((off, content))
                    break

    raw_sections.sort(key=lambda x: x[0])
    if raw_sections and float(raw_sections[0][0]) > 0:
        raw_sections.insert(0, (0.0, "Theme"))
    if len(raw_sections) < 2:
        return None

    total_offset = max(n["offset"] for n in all_notes) + 0.5

    section_ranges: dict[int, tuple[float, float]] = {}
    for i, (off, lbl) in enumerate(raw_sections):
        k        = label_key(lbl)
        next_off = raw_sections[i + 1][0] if i + 1 < len(raw_sections) else total_offset
        section_ranges[k] = (float(off), float(next_off))

    result: dict[int, dict] = {}
    for k, (off_start, off_end) in section_ranges.items():
        seg_notes = [n for n in all_notes if off_start <= n["offset"] < off_end]

        pc = np.zeros(12)
        for n in seg_notes:
            pc[n["pitch"] % 12] += 1
        key_info = _detect_key(pc)
        tonic    = key_info["score_tonic_semitone"]

        pcp = np.zeros(12)
        for n in seg_notes:
            pcp[n["pitch"] % 12] += n.get("duration", 0.0)
        pcp_sum  = float(pcp.sum())
        pcp_norm = (pcp / pcp_sum) if pcp_sum > 1e-9 else np.zeros(12)

        pitch_floor = float(np.percentile([n["pitch"] for n in seg_notes], 40)) \
                      if seg_notes else 60.0
        n_beats     = max(1, int(np.ceil(off_end - off_start)))
        score_beat_midi: list[float] = []
        for b in range(n_beats):
            bt_start   = off_start + b
            bt_end     = off_start + b + 1
            candidates = [
                n["pitch"] for n in seg_notes
                if bt_start <= n["offset"] < bt_end and n["pitch"] >= pitch_floor
            ]
            if candidates:
                score_beat_midi.append(float(max(candidates)))
            elif score_beat_midi:
                score_beat_midi.append(score_beat_midi[-1])
            else:
                score_beat_midi.append(60.0)

        result[k] = {
            "score_beat_midi":           [round(v, 2) for v in score_beat_midi],
            "score_beat_midi_relative":  _to_relative(score_beat_midi, tonic),
            "score_pitch_class_profile": [round(float(v), 6) for v in pcp_norm],
            **key_info,
        }

    return result

