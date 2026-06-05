"""
app/services/symbolic.py
─────────────────────────
Symbolic music feature extraction from note lists.

Supports two source paths:
  1. MusicXML  — parse MXL → per-section note lists (accurate, score-based)
  2. MIDI      — parse MIDI → notes sliced by audio-annotation timestamps

Used by:
  - api/symbolic.py  (get_symbolic_features)
"""

import math
import re
import zipfile
from collections import Counter
from pathlib import Path

from app.core.config import MUSICXML_DIR

# Krumhansl-Kessler pitch-class profiles (tonal clarity calculation)
_KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

# Feature metadata: (key, label_zh, label_en, category, chart_type)
SYMBOLIC_FEATURE_DEFS = [
    # ── Pitch (12) ──────────────────────────────────────────────────────
    ("pitch_range",               "音域跨度",     "Pitch Range",               "P", "continuous"),
    ("mean_pitch",                "平均音高",     "Mean Pitch",                "P", "continuous"),
    ("pitch_std",                 "音高标准差",   "Pitch Std Dev",             "P", "continuous"),
    ("pitch_variety",             "音级种类数",   "Pitch Variety",             "P", "count"),
    ("most_common_pc_prevalence", "主音级占比",   "Most Common PC Prevalence", "P", "ratio"),
    ("pitch_class_entropy",       "音级熵",       "Pitch Class Entropy",       "P", "entropy"),
    ("bass_register_ratio",       "低音区占比",   "Bass Register Ratio",       "P", "ratio"),
    ("high_register_ratio",       "高音区占比",   "High Register Ratio",       "P", "ratio"),
    ("most_common_pc",            "最常见音级",   "Most Common Pitch Class",   "P", "count"),
    ("tonal_clarity",             "调性清晰度",   "Tonal Clarity",             "P", "ratio"),
    ("chromatic_density",         "半音密度",     "Chromatic Density",         "P", "ratio"),
    ("interval_class_variety",    "音程类种类数", "Interval Class Variety",    "P", "count"),
    # ── Melodic (10) ────────────────────────────────────────────────────
    ("mean_melodic_interval",     "平均旋律音程", "Mean Melodic Interval",     "M", "continuous"),
    ("repeated_notes_ratio",      "重复音比率",   "Repeated Notes Ratio",      "M", "ratio"),
    ("stepwise_ratio",            "级进比率",     "Stepwise Ratio",            "M", "ratio"),
    ("chromatic_ratio",           "半音比率",     "Chromatic Ratio",           "M", "ratio"),
    ("leap_ratio",                "跳进比率",     "Leap Ratio",                "M", "ratio"),
    ("large_leap_ratio",          "大跳比率",     "Large Leap Ratio",          "M", "ratio"),
    ("direction_of_motion",       "旋律走向",     "Direction of Motion",       "M", "signed"),
    ("arpeggiation_ratio",        "琶音比率",     "Arpeggiation Ratio",        "M", "ratio"),
    ("melodic_interval_variety",  "音程种类数",   "Melodic Interval Variety",  "M", "count"),
    ("interval_entropy",          "音程熵",       "Interval Entropy",          "M", "entropy"),
    # ── Rhythmic (8) ────────────────────────────────────────────────────
    ("note_density",              "音符密度",     "Note Density",              "R", "continuous"),
    ("mean_note_duration",        "平均时值",     "Mean Note Duration",        "R", "continuous"),
    ("duration_variability",      "时值变化率",   "Duration Variability",      "R", "continuous"),
    ("short_note_ratio",          "短音符比率",   "Short Note Ratio",          "R", "ratio"),
    ("long_note_ratio",           "长音符比率",   "Long Note Ratio",           "R", "ratio"),
    ("rest_ratio",                "休止比率",     "Rest Ratio",                "R", "ratio"),
    ("rhythmic_value_variety",    "时值种类数",   "Rhythmic Value Variety",    "R", "count"),
    ("duration_entropy",          "时值熵",       "Duration Entropy",          "R", "entropy"),
    # ── Texture (3) ─────────────────────────────────────────────────────
    ("max_simultaneous_notes",    "最大和弦厚度", "Max Simultaneous Notes",    "T", "count"),
    ("mean_simultaneous_notes",   "平均和弦厚度", "Mean Simultaneous Notes",   "T", "continuous"),
    ("chord_onset_ratio",         "和弦起始比率", "Chord Onset Ratio",         "T", "ratio"),
]

_MXL_SKIP = ("m.s.", "m.d.", "destra", "sinistra", "ritard", "fine", "segue",
              "rit.", "poco", "sempre", "cresc", "decresc", "dim.", "sfz", "fz",
              "dolce", "legato", "staccato", "andantino", "andante",
              "allegro", "adagio", "moderato", "presto", "vivace", "largo", "lento")

_MXL_ROMAN = {
    "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8,
    "ix": 9, "x": 10, "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15,
    "xvi": 16, "xvii": 17, "xviii": 18, "xix": 19, "xx": 20, "xxi": 21,
    "xxii": 22, "xxiii": 23, "xxiv": 24, "xxv": 25, "xxvi": 26, "xxvii": 27,
    "xxviii": 28, "xxix": 29, "xxx": 30,
}


# ── MusicXML helpers ──────────────────────────────────────────────────────────

def mxl_label_key(label: str) -> int:
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
        n_ = _MXL_ROMAN.get(m2.group(1).strip().lower())
        if n_:
            return n_
    return 998


def mxl_key_to_label(key: int, orig: str = "") -> str:
    if key == 0:   return "T"
    if key == 999: return "C"
    if key == 998: return orig.strip() or "?"
    if key >= 1:   return f"V{key}"
    return orig.strip() or "?"


def find_mxl_for_stem(piece_stem: str) -> "Path | None":
    for ext in (".mxl", ".xml", ".musicxml"):
        p = MUSICXML_DIR / f"{piece_stem}{ext}"
        if p.exists():
            return p
    return None


def read_mxl_xml_bytes(path: Path) -> bytes:
    if path.suffix.lower() == ".mxl":
        with zipfile.ZipFile(path, "r") as z:
            xml_name = next(
                (n for n in z.namelist()
                 if n.endswith(".xml") and "META" not in n.upper()), None)
            if xml_name is None:
                raise ValueError("No XML inside .mxl")
            return z.read(xml_name)
    return path.read_bytes()


def parse_mxl_symbolic(piece_stem: str) -> "list[dict] | None":
    """
    Parse MusicXML and return per-section note lists for compute_symbolic_features().

    Returns list of:
        { label: str, notes_sec: list[{pitch,start_sec,dur_sec}], seg_dur_sec: float }
    or None if MusicXML unavailable / no rehearsal marks found.
    """
    path = find_mxl_for_stem(piece_stem)
    if path is None:
        return None

    try:
        import music21
        xml_bytes = read_mxl_xml_bytes(path)
        score = music21.converter.parseData(xml_bytes, format="musicxml")
    except Exception as e:
        print(f"  [symbolic] MusicXML parse error ({piece_stem}): {e}")
        return None

    if not score.parts:
        return None

    qpm = 120.0
    for el in score.flatten():
        if hasattr(el, "number") and el.classes and "MetronomeMark" in el.classes:
            try:
                qpm = float(el.number)
                break
            except Exception:
                pass

    def qn_to_sec(qn: float) -> float:
        return qn * 60.0 / qpm

    all_notes: list[dict] = []
    for part in score.parts:
        for el in part.flatten().notes:
            if hasattr(el, "pitch"):
                all_notes.append({
                    "pitch":    el.pitch.midi,
                    "start_qn": float(el.offset),
                    "dur_qn":   float(el.duration.quarterLength) or 0.125,
                })
            else:
                for p in el.pitches:
                    all_notes.append({
                        "pitch":    p.midi,
                        "start_qn": float(el.offset),
                        "dur_qn":   float(el.duration.quarterLength) or 0.125,
                    })

    if not all_notes:
        return None

    part0    = score.parts[0]
    measures = list(part0.getElementsByClass("Measure"))

    raw_sections: list[tuple[float, str]] = []
    seen_off: set[float] = set()
    for m in measures:
        off = float(m.offset)
        if off in seen_off:
            continue
        seen_off.add(off)
        for el in m.flatten():
            if el.classes and (
                "RehearsalMark" in el.classes or "TextExpression" in el.classes
            ):
                content = (
                    el.content if hasattr(el, "content") else str(el)
                ).strip()
                if not content:
                    continue
                low = content.lower()
                if any(k in low for k in _MXL_SKIP):
                    continue
                if low.startswith(("tema", "var", "theme", "coda", "finale",
                                   "minore", "maggiore", "trio", "thema")):
                    raw_sections.append((off, content))
                    break

    raw_sections.sort(key=lambda x: x[0])
    if raw_sections and float(raw_sections[0][0]) > 0:
        raw_sections.insert(0, (0.0, "Theme"))

    if len(raw_sections) < 2:
        return None

    total_qn = max(n["start_qn"] for n in all_notes) + 0.5

    result: list[dict] = []
    for i, (off, lbl) in enumerate(raw_sections):
        key      = mxl_label_key(lbl)
        next_off = raw_sections[i + 1][0] if i + 1 < len(raw_sections) else total_qn
        off_f    = float(off)
        nxt_f    = float(next_off)

        seg_notes_raw = [n for n in all_notes if off_f <= n["start_qn"] < nxt_f]
        seg_dur_sec   = qn_to_sec(nxt_f - off_f)

        notes_sec = [
            {
                "pitch":     n["pitch"],
                "start_sec": qn_to_sec(n["start_qn"] - off_f),
                "dur_sec":   max(qn_to_sec(n["dur_qn"]), 0.01),
            }
            for n in seg_notes_raw
        ]

        result.append({
            "label":       mxl_key_to_label(key, lbl),
            "notes_sec":   notes_sec,
            "seg_dur_sec": seg_dur_sec,
        })

    return result


# ── Symbolic feature computation ──────────────────────────────────────────────

def compute_symbolic_features(notes_sec: list[dict], seg_dur: float) -> dict:
    """
    Compute 26 scalar symbolic features for one segment.

    Each note dict: { "pitch": int, "start_sec": float, "dur_sec": float }
    seg_dur: total duration of the segment in seconds.
    """
    result: dict = {k: 0.0 for k, *_ in SYMBOLIC_FEATURE_DEFS}

    if not notes_sec:
        return result

    pitches   = [n["pitch"]     for n in notes_sec]
    pcs       = [p % 12         for p in pitches]
    durations = [max(n["dur_sec"], 1e-6) for n in notes_sec]
    starts    = [n["start_sec"] for n in notes_sec]
    n         = len(notes_sec)

    # ── Pitch ─────────────────────────────────────────────────────────────
    mean_p = sum(pitches) / n
    result["pitch_range"]  = float(max(pitches) - min(pitches))
    result["mean_pitch"]   = mean_p
    result["pitch_std"]    = math.sqrt(sum((p - mean_p) ** 2 for p in pitches) / n)
    result["pitch_variety"] = float(len(set(pcs)))

    pc_counts = Counter(pcs)
    result["most_common_pc_prevalence"] = pc_counts.most_common(1)[0][1] / n

    pc_ent = 0.0
    for cnt in pc_counts.values():
        p_ = cnt / n
        if p_ > 0:
            pc_ent -= p_ * math.log2(p_)
    result["pitch_class_entropy"] = pc_ent / math.log2(12) if pc_ent > 0 else 0.0

    result["bass_register_ratio"] = sum(1 for p in pitches if p < 48) / n
    result["high_register_ratio"] = sum(1 for p in pitches if p > 72) / n
    result["most_common_pc"]      = float(pc_counts.most_common(1)[0][0])
    result["chromatic_density"]   = len(set(pcs)) / 12.0

    pc_hist = [0] * 12
    for pc_ in pcs:
        pc_hist[pc_] += 1

    def _pearson(a: list, b: list) -> float:
        n_ = len(a); ma = sum(a) / n_; mb = sum(b) / n_
        num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
        sa  = math.sqrt(sum((x - ma) ** 2 for x in a))
        sb  = math.sqrt(sum((y - mb) ** 2 for y in b))
        return num / (sa * sb) if sa * sb > 1e-9 else 0.0

    best = 0.0
    for root in range(12):
        maj = [_KK_MAJOR[(i - root) % 12] for i in range(12)]
        mn  = [_KK_MINOR[(i - root) % 12] for i in range(12)]
        best = max(best, _pearson(pc_hist, maj), _pearson(pc_hist, mn))
    result["tonal_clarity"] = max(0.0, best)

    # ── Melodic ───────────────────────────────────────────────────────────
    if n >= 2:
        sn     = sorted(notes_sec, key=lambda x: x["start_sec"])
        sp     = [x["pitch"] for x in sn]
        raw_iv = [sp[i + 1] - sp[i] for i in range(len(sp) - 1)]
        abs_iv = [abs(iv) for iv in raw_iv]
        n_iv   = len(abs_iv)

        result["mean_melodic_interval"]    = sum(abs_iv) / n_iv
        result["repeated_notes_ratio"]     = sum(1 for iv in abs_iv if iv == 0) / n_iv
        result["stepwise_ratio"]           = sum(1 for iv in abs_iv if iv <= 2) / n_iv
        result["chromatic_ratio"]          = sum(1 for iv in abs_iv if iv == 1) / n_iv
        result["leap_ratio"]               = sum(1 for iv in abs_iv if iv > 4) / n_iv
        result["large_leap_ratio"]         = sum(1 for iv in abs_iv if iv > 7) / n_iv
        result["arpeggiation_ratio"]       = sum(1 for iv in abs_iv if iv in (3, 4, 7, 8)) / n_iv

        asc   = sum(1 for iv in raw_iv if iv > 0)
        desc  = sum(1 for iv in raw_iv if iv < 0)
        denom = asc + desc
        result["direction_of_motion"]      = (asc - desc) / denom if denom else 0.0
        result["melodic_interval_variety"] = float(len(set(abs_iv)))

        ics = set(min(iv % 12, 12 - iv % 12) for iv in abs_iv)
        result["interval_class_variety"] = float(len(ics))

        iv_counts = Counter(abs_iv)
        iv_ent    = 0.0
        for cnt in iv_counts.values():
            p_ = cnt / n_iv
            if p_ > 0:
                iv_ent -= p_ * math.log2(p_)
        max_iv_ent = math.log2(len(iv_counts)) if len(iv_counts) > 1 else 1.0
        result["interval_entropy"] = iv_ent / max_iv_ent if max_iv_ent > 0 else 0.0

    # ── Rhythmic ──────────────────────────────────────────────────────────
    mean_d = sum(durations) / n
    result["note_density"]       = n / max(seg_dur, 1e-6)
    result["mean_note_duration"] = mean_d

    if n >= 2:
        std_d  = math.sqrt(sum((d - mean_d) ** 2 for d in durations) / n)
        result["duration_variability"] = std_d / mean_d if mean_d > 0 else 0.0

        sorted_d = sorted(durations)
        median_d = sorted_d[n // 2]
        result["short_note_ratio"] = sum(1 for d in durations if d < median_d * 0.5) / n
        result["long_note_ratio"]  = sum(1 for d in durations if d > median_d * 2.0) / n

        BIN = 0.04
        bins      = [round(d / BIN) for d in durations]
        bin_counts = Counter(bins)
        result["rhythmic_value_variety"] = float(len(bin_counts))

        dur_ent = 0.0
        for cnt in bin_counts.values():
            p_ = cnt / n
            if p_ > 0:
                dur_ent -= p_ * math.log2(p_)
        max_dur_ent = math.log2(len(bin_counts)) if len(bin_counts) > 1 else 1.0
        result["duration_entropy"] = dur_ent / max_dur_ent if max_dur_ent > 0 else 0.0

    # ── Texture ───────────────────────────────────────────────────────────
    events: list[tuple[float, int]] = []
    for note in notes_sec:
        events.append((note["start_sec"], 1))
        events.append((note["start_sec"] + note["dur_sec"], -1))
    events.sort(key=lambda x: (x[0], x[1]))

    if events and seg_dur > 0:
        _sound_time = 0.0
        _curr = 0
        _prev_t: "float | None" = None
        for _t, _d in events:
            if _prev_t is not None and _t > _prev_t and _curr > 0:
                _sound_time += _t - _prev_t
            _curr += _d
            _prev_t = _t
        result["rest_ratio"] = max(0.0, 1.0 - _sound_time / seg_dur)
    else:
        result["rest_ratio"] = 0.0

    curr = 0; max_sim = 0; total_w = 0.0; prev_t: "float | None" = None
    for t, delta in events:
        if prev_t is not None and t > prev_t and curr > 0:
            total_w += curr * (t - prev_t)
        curr += delta
        if curr > max_sim:
            max_sim = curr
        prev_t = t

    span = events[-1][0] - events[0][0] if len(events) >= 2 else 0.0
    result["max_simultaneous_notes"]  = float(max_sim)
    result["mean_simultaneous_notes"] = total_w / span if span > 0 else 1.0

    CHORD_TOL   = 0.05
    onset_times = sorted(note["start_sec"] for note in notes_sec)
    is_chord    = [False] * len(onset_times)
    for i in range(len(onset_times)):
        for j in range(i + 1, len(onset_times)):
            if onset_times[j] - onset_times[i] > CHORD_TOL:
                break
            is_chord[i] = True
            is_chord[j] = True
    result["chord_onset_ratio"] = sum(is_chord) / len(onset_times) if onset_times else 0.0

    return {k: round(v, 6) for k, v in result.items()}


def compute_distributions(notes_sec: list[dict]) -> dict:
    """
    Compute three normalized histograms for one segment:
      pitch_class      – 12 bins (PC 0–11)
      melodic_interval – 13 bins (|semitone interval| 0–11, last bin = ≥12)
      note_duration    – 12 bins (0–0.1 s, 0.1–0.2 s, …, ≥1.1 s)
    """
    n = len(notes_sec)

    pc = [0.0] * 12
    for note in notes_sec:
        pc[int(note["pitch"]) % 12] += 1.0
    total_pc = sum(pc) or 1.0
    pc = [v / total_pc for v in pc]

    mi = [0.0] * 13
    if n >= 2:
        sorted_notes = sorted(notes_sec, key=lambda x: x["start_sec"])
        for i in range(1, len(sorted_notes)):
            iv = abs(int(sorted_notes[i]["pitch"]) - int(sorted_notes[i - 1]["pitch"]))
            mi[min(iv, 12)] += 1.0
        total_mi = sum(mi) or 1.0
        mi = [v / total_mi for v in mi]

    dur = [0.0] * 12
    for note in notes_sec:
        bin_idx = min(int(note["dur_sec"] / 0.1), 11)
        dur[bin_idx] += 1.0
    total_dur = sum(dur) or 1.0
    dur = [v / total_dur for v in dur]

    return {
        "pitch_class":      [round(v, 6) for v in pc],
        "melodic_interval": [round(v, 6) for v in mi],
        "note_duration":    [round(v, 6) for v in dur],
    }
