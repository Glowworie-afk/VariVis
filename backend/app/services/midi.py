"""
app/services/midi.py
─────────────────────
MIDI file lookup and per-variation structural analysis.

Used by:
  - api/midi.py   (get_midi_notes, get_midi_analysis)
  - api/symbolic.py  (MIDI fallback for symbolic feature extraction)
"""

import collections
import math
import re
from pathlib import Path

import pandas as pd

from app.core.config import ANNOTATION, MIDI_DIR
from app.services.musicxml import get_musicxml_sections
from app.services.score_matching import extract_catalog_numbers

try:
    import mido
except ImportError:
    mido = None  # type: ignore


def extract_k_number(text: str) -> "str | None":
    """'WAMozart_K265_1' → '265'"""
    m = re.search(r"[Kk][Vv]?\.?(\d+)", text)
    return m.group(1) if m else None


def find_midi_file(file_name: str) -> "Path | None":
    """
    Fuzzy-match file_name → .mid in TV_MIDI/.

    Priority:
      1. Exact stem match
      2. K/KV match (Mozart)
      3. Op match + composer guard
      4. WoO match + composer guard
      5. Hob match (Haydn)
    """
    if not MIDI_DIR.exists():
        return None

    midis = sorted(MIDI_DIR.glob("*.mid"))
    if not midis:
        return None

    exact = MIDI_DIR / f"{file_name}.mid"
    if exact.exists():
        return exact

    qn = extract_catalog_numbers(file_name)

    for p in midis:
        mn = extract_catalog_numbers(p.stem)

        if qn.get("kv") and qn["kv"] == mn.get("kv"):
            return p

        if qn.get("op") and qn["op"] == mn.get("op"):
            qc, mc = qn.get("composer"), mn.get("composer")
            if not qc or not mc or qc == mc:
                return p

        if qn.get("woo") and qn["woo"] == mn.get("woo"):
            qc, mc = qn.get("composer"), mn.get("composer")
            if not qc or not mc or qc == mc:
                return p

        if qn.get("hob") and qn["hob"] == mn.get("hob"):
            return p

    return None


def parse_midi_analysis(midi_path: Path, n_variations: "int | None" = None) -> dict:
    """Parse MIDI → per-variation stats for all 5 structural dimensions.
    n_variations: if provided, divide total_bars into n_variations+1 equal segments
    (Theme + N vars) regardless of annotation lookup or hardcoded fallback.
    """
    if mido is None:
        raise RuntimeError("mido not installed. Run: pip install mido")

    mid = mido.MidiFile(str(midi_path))
    tpb = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    tempo_map: list[tuple[int, int]] = [(0, 500_000)]
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "set_tempo":
            tempo_map.append((abs_t, msg.tempo))

    def tick2sec(tick: int) -> float:
        sec = 0.0
        for i in range(len(tempo_map)):
            t0, tmpo = tempo_map[i]
            t1 = tempo_map[i + 1][0] if i + 1 < len(tempo_map) else tick
            if t0 >= tick:
                break
            seg = min(t1, tick)
            sec += (seg - t0) * tmpo / 1_000_000 / tpb
            if seg >= tick:
                break
        return sec

    notes: list[dict] = []
    active: dict = {}
    abs_t = 0
    beats_per_bar = 3

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
                notes.append({
                    "onset_sec": tick2sec(on_t),
                    "pitch":     msg.note,
                    "velocity":  vel,
                    "dur_sec":   max(0.01, tick2sec(abs_t) - tick2sec(on_t)),
                    "beat":      on_t / tpb,
                })

    if not notes:
        raise ValueError("No notes found in MIDI file")

    notes.sort(key=lambda n: n["beat"])

    def note_bar(n: dict) -> int:
        return int(n["beat"] / beats_per_bar)

    total_bars = max(note_bar(n) for n in notes) + 1

    seg_method = "fallback"
    var_labels: list[str] = []
    var_starts: list[int] = []

    # Strategy 0: MusicXML section markers
    midi_stem = midi_path.stem
    mxml_secs = get_musicxml_sections(midi_stem)
    if mxml_secs:
        var_labels = [s[0] for s in mxml_secs]
        var_starts = [s[1] for s in mxml_secs]
        seg_method = "musicxml"

    # Strategy 1: caller-supplied n_variations
    if not var_labels and n_variations is not None and n_variations >= 1:
        n_segs     = n_variations + 1
        step       = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_variations + 1)]
        seg_method = "caller"

    # Strategy 2: annotation lookup
    k_num = extract_k_number(midi_path.name)
    if not var_labels and k_num and ANNOTATION.exists():
        try:
            ann = pd.read_excel(ANNOTATION)
            pat = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
            rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
            if not rows.empty:
                row = rows.iloc[0]
                raw_labels = str(row.get("label", "")).strip()
                raw_labels = raw_labels.strip("[]").replace("'", "").replace('"', "")
                seg_labels_raw = [s.strip() for s in raw_labels.split(",") if s.strip()]

                def _norm_label(lbl: str) -> str:
                    if lbl in ("T", "Theme"):
                        return "Theme"
                    if lbl in ("C", "Coda"):
                        return "Coda"
                    m = re.match(r"V(\d+)", lbl, re.IGNORECASE)
                    if m:
                        return f"Var.{int(m.group(1)):02d}"
                    return lbl

                seg_labels_raw = [_norm_label(l) for l in seg_labels_raw]
                n_segs = len(seg_labels_raw)
                if n_segs >= 2:
                    step       = total_bars / n_segs
                    var_starts = [round(i * step) for i in range(n_segs)]
                    var_labels = seg_labels_raw
                    seg_method = "annotation"
        except Exception:
            pass

    # Strategy 3: hardcoded fallback
    if not var_labels:
        theme_bars = 16
        var_bars   = 16
        var_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, 13)]
        var_starts = [0] + [theme_bars + i * var_bars for i in range(12)]
        seg_method = "fallback"

    var_ends = var_starts[1:] + [total_bars]

    def notes_in(s: int, e: int) -> list[dict]:
        return [n for n in notes if s <= note_bar(n) < e]

    KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
    KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
    main_tempo = tempo_map[1][1] if len(tempo_map) > 1 else 500_000
    beat_dur   = main_tempo / 1_000_000

    mel_mean, mel_lo, mel_hi        = [], [], []
    stp_r, lp_r, mean_iv            = [], [], []
    harm_t, harm_d, harm_s          = [], [], []
    vel_mean_l, vel_std_l           = [], []
    rhy_quarter, rhy_8th, rhy_16th, rhy_32nd = [], [], [], []
    chroma_list: list[list[float]]  = []
    key_root_l:  list[int]          = []
    key_mode_l:  list[str]          = []

    for s, e in zip(var_starts, var_ends):
        nl = notes_in(s, e)

        if nl:
            bb: dict = collections.defaultdict(list)
            for n in nl:
                bb[round(n["beat"] * 2) / 2].append(n["pitch"])
            tops        = [max(v) for v in bb.values()]
            tops_sorted = sorted(tops)
            p10 = tops_sorted[max(0, int(len(tops_sorted) * 0.10))]
            p90 = tops_sorted[min(len(tops_sorted) - 1, int(len(tops_sorted) * 0.90))]
            mel_mean.append(round(sum(tops) / len(tops), 1))
            mel_lo.append(p10)
            mel_hi.append(p90)
        else:
            mel_mean.append(60); mel_lo.append(60); mel_hi.append(60)

        ps  = [n["pitch"] for n in sorted(nl, key=lambda n: n["beat"])]
        ivs = [abs(ps[i + 1] - ps[i]) for i in range(len(ps) - 1)]
        if ivs:
            stp_r.append(round(sum(1 for v in ivs if v <= 2) / len(ivs), 3))
            lp_r.append(round(sum(1 for v in ivs if v > 4) / len(ivs), 3))
            mean_iv.append(round(sum(ivs) / len(ivs), 2))
        else:
            stp_r.append(0); lp_r.append(0); mean_iv.append(0)

        pc_raw = [0.0] * 12
        for n in nl:
            pc_raw[n["pitch"] % 12] += 1
        s_pc = sum(pc_raw) or 1
        pc   = [v / s_pc for v in pc_raw]

        mu_c  = sum(pc) / 12
        ss_c  = sum((x - mu_c) ** 2 for x in pc) or 1e-9
        best_r, best_root, best_mode_v = -999.0, 0, "major"
        for root in range(12):
            for mode_name, prof in (("major", KS_MAJOR), ("minor", KS_MINOR)):
                rot  = [prof[(j - root) % 12] for j in range(12)]
                mu_p = sum(rot) / 12
                num  = sum((rot[j] - mu_p) * (pc[j] - mu_c) for j in range(12))
                den  = math.sqrt(sum((x - mu_p) ** 2 for x in rot) * ss_c)
                r    = num / den if den > 0 else 0.0
                if r > best_r:
                    best_r, best_root, best_mode_v = r, root, mode_name

        chroma_list.append([round(v, 4) for v in pc])
        key_root_l.append(best_root)
        key_mode_l.append(best_mode_v)

        root = best_root
        if best_mode_v == "major":
            t_pcs  = {root % 12, (root + 4) % 12, (root + 7) % 12}
            d_pcs  = {(root + 7) % 12, (root + 11) % 12, (root + 2) % 12}
            su_pcs = {(root + 5) % 12, (root + 9) % 12, root % 12}
        else:
            t_pcs  = {root % 12, (root + 3) % 12, (root + 7) % 12}
            d_pcs  = {(root + 7) % 12, (root + 11) % 12, (root + 2) % 12}
            su_pcs = {(root + 5) % 12, (root + 8) % 12, root % 12}
        t_  = sum(pc[p] for p in t_pcs)
        d_  = sum(pc[p] for p in d_pcs)
        su_ = sum(pc[p] for p in su_pcs)
        td  = t_ + d_ + su_ or 1
        harm_t.append(round(t_ / td, 3))
        harm_d.append(round(d_ / td, 3))
        harm_s.append(round(su_ / td, 3))

        rq = re = rs = rt = 0
        for n in nl:
            r = n["dur_sec"] / beat_dur
            if   r >= 0.75: rq += 1
            elif r >= 0.37: re += 1
            elif r >= 0.18: rs += 1
            else:           rt += 1
        tot = rq + re + rs + rt or 1
        rhy_quarter.append(round(rq / tot, 3))
        rhy_8th.append(round(re / tot, 3))
        rhy_16th.append(round(rs / tot, 3))
        rhy_32nd.append(round(rt / tot, 3))

        vels   = [n["velocity"] for n in nl] or [64]
        mean_v = sum(vels) / len(vels)
        std_v  = math.sqrt(sum((v - mean_v) ** 2 for v in vels) / len(vels))
        vel_mean_l.append(round(mean_v, 1))
        vel_std_l.append(round(std_v, 1))

    return {
        "matched":       True,
        "midi_file":     midi_path.name,
        "total_bars":    total_bars,
        "beats_per_bar": beats_per_bar,
        "seg_method":    seg_method,
        "var_labels":    var_labels,
        "var_starts":    var_starts,
        "var_ends":      var_ends,
        "mel_mean":      mel_mean,
        "mel_lo":        mel_lo,
        "mel_hi":        mel_hi,
        "stp_r":         stp_r,
        "lp_r":          lp_r,
        "mean_iv":       mean_iv,
        "harm_t":        harm_t,
        "harm_d":        harm_d,
        "harm_s":        harm_s,
        "chroma":        chroma_list,
        "key_root":      key_root_l,
        "key_mode":      key_mode_l,
        "vel_mean":      vel_mean_l,
        "vel_std":       vel_std_l,
        "rhy_quarter":   rhy_quarter,
        "rhy_8th":       rhy_8th,
        "rhy_16th":      rhy_16th,
        "rhy_32nd":      rhy_32nd,
    }
