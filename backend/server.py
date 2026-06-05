"""
VariVis API Server
==================
用法（在 backend/ 目录，激活 venv 后）：
    uvicorn server:app --reload --port 8000

提供接口：
    GET  /api/pieces              — 列出 TV_annotation.xlsx 中所有变奏曲
    GET  /api/features/{name}     — 返回已提取的 JSON（404 表示未提取）
    GET  /api/extract/{name}      — SSE 流：依次运行 extract + add_pitch_contour，
                                    实时推送进度行；结束时发送 DONE 或 ERROR
"""

import asyncio
import base64
import collections
import difflib
import json
import math
import os
import re
import sys
from pathlib import Path

try:
    import mido
except ImportError:
    mido = None  # type: ignore

try:
    import librosa
    import numpy as np
except ImportError:
    librosa = None  # type: ignore
    np = None       # type: ignore

import pandas as pd
import shutil
import tempfile
import uuid
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, Response

# ── 路径配置 ─────────────────────────────────────────────────────────
BACKEND_DIR  = Path(__file__).parent
BASE_DIR     = BACKEND_DIR.parent
FEATURE_DIR  = BACKEND_DIR / "features"
ANNOTATION   = BACKEND_DIR / "data" / "TV_annotation.xlsx"
AUDIO_DIR    = BASE_DIR / "TV_dataset_audio"
IMSLP_DIR    = BASE_DIR / "IMSLP"
MIDI_DIR     = BASE_DIR / "TV_MIDI"
MUSICXML_DIR = BASE_DIR / "MusicXML"
MUSICXML_DIR.mkdir(exist_ok=True)

app = FastAPI(title="VariVis API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Vite dev server on any port
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── /api/pieces ──────────────────────────────────────────────────────

@app.get("/api/pieces")
def list_pieces():
    """
    读取 TV_annotation.xlsx，返回所有变奏曲的元信息。
    包含 `extracted` 字段（True = JSON 已存在，可直接加载）。
    """
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
        # Use the full fuzzy matcher (exact stem + K/Op/WoO/Hob)
        has_midi = _find_midi_file(name) is not None
        results.append({
            "file_name":    name,
            "music_name":   str(row.get("music_name", "")),
            "composer":     str(row.get("composer",   "")),
            "instrument":   str(row.get("instrument", "")),
            "period":       str(row.get("period",     "")),
            "folder":       str(row.get("folder",     "")),
            "extracted":    (FEATURE_DIR / f"{name}.json").exists(),
            "has_midi":     has_midi,
        })

    return results


# ── /api/features/{file_name} ────────────────────────────────────────

@app.get("/api/features/{file_name}")
def get_features(file_name: str):
    """返回已提取的特征 JSON；若不存在返回 404。"""
    path = FEATURE_DIR / f"{file_name}.json"
    if not path.exists():
        raise HTTPException(404, f"Features not found for '{file_name}'. Run extraction first.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ── /api/audio/{file_name} ───────────────────────────────────────────

@app.get("/api/audio/{file_name}")
def get_audio(file_name: str, folder: str = ""):
    """
    返回变奏曲的音频文件（WAV）。
    优先使用 ?folder= 参数定位；未提供时自动搜索所有子目录。
    """
    # Try with provided folder
    if folder:
        path = AUDIO_DIR / folder / f"{file_name}.wav"
        if path.exists():
            return FileResponse(str(path), media_type="audio/wav",
                                headers={"Accept-Ranges": "bytes"})

    # Fallback: search all subdirectories
    if AUDIO_DIR.exists():
        for d in AUDIO_DIR.iterdir():
            if d.is_dir():
                path = d / f"{file_name}.wav"
                if path.exists():
                    return FileResponse(str(path), media_type="audio/wav",
                                        headers={"Accept-Ranges": "bytes"})

    raise HTTPException(404, f"Audio file not found: {file_name}.wav")


# ── /api/extract/{file_name} — SSE 流 ───────────────────────────────

@app.get("/api/extract/{file_name}")
async def extract_stream(file_name: str):
    """
    Server-Sent Events 端点。

    依次运行两个脚本，将每一行 stdout/stderr 作为 SSE 事件推给前端：
        1. extract_features.py  <file_name>
        2. add_pitch_contour.py <file_name>

    特殊事件：
        data: STEP:extract    — 第一步开始
        data: STEP:pyin       — 第二步开始
        data: DONE            — 全部成功完成
        data: ERROR:<msg>     — 某一步失败
    """

    async def stream():
        # Step 1
        yield f"data: STEP:extract\n\n"
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

        # Step 2
        yield f"data: STEP:pyin\n\n"
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
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering if proxied
        },
    )


# ── Score analysis helpers ───────────────────────────────────────────

def _extract_catalog_numbers(text: str) -> dict:
    """
    Extract all music catalog numbers from a string.
    Returns dict with keys: kv, woo, op, hob, composer

    Handles both underscore-delimited filenames and natural-language strings:
      'WAMozart_K265_1'                    → { kv: '265', composer: 'mozart' }
      'LBeethoven_OP34_1'                  → { op: '34',  composer: 'beethoven' }
      'LBeethoven_WOO67_2'                 → { woo: '67', composer: 'beethoven' }
      'JHaydn_XVII5_1'                     → { hob: '17_5', composer: 'haydn' }
      'Beethoven - 6 Variations, Op. 34'   → { op: '34',  composer: 'beethoven' }
      'Wolfgang Amadeus Mozart: ... K.265' → { kv: '265', composer: 'mozart' }

    Note: underscores are normalised to spaces so that \b word-boundaries work
    correctly on both filename-style and natural-language inputs.
    """
    nums: dict = {}
    # Normalise: replace underscores with spaces so \b works on "_K265_" etc.
    t = text.upper().replace("_", " ")

    # Mozart K / KV number  (K265, KV265, K.265, KV.265)
    m = re.search(r'\bK\.?V?\.?\s*(\d+)', t)
    if m:
        nums['kv'] = m.group(1)

    # Beethoven WoO number  (WOO67, WoO 67, WO67)
    m = re.search(r'\bWO+\.?\s*(\d+)', t)
    if m:
        nums['woo'] = m.group(1)

    # Opus number  (OP34, Op.34, Op. 34, Opus 34)
    m = re.search(r'\bOP(?:US)?\.?\s*(\d+)', t)
    if m:
        nums['op'] = m.group(1)

    # Haydn Hoboken XVII:N  ("Hob.XVII:6", "XVII:6", "XVII6", "XVII 6")
    m = re.search(r'(?:HOB(?:\.|\s+)?)?XVII[:./ ]?\s*(\d+)', t)
    if m:
        nums['hob'] = f'17_{m.group(1)}'

    # Composer surname (first match wins)
    for name in ('MOZART', 'BEETHOVEN', 'HAYDN', 'SCHUBERT', 'BRAHMS',
                 'CHOPIN', 'LISZT', 'SCHUMANN', 'HANDEL', 'BACH',
                 'DVORAK', 'RUBINSTEIN', 'RACHMANINOFF', 'GLAZUNOV',
                 'JANACEK', 'EIGES'):
        if name in t:
            nums['composer'] = name.lower()
            break

    return nums


def _best_imslp_match(file_name: str, music_name: str) -> tuple[str | None, float, list[str]]:
    """
    Fuzzy-match (file_name, music_name) → best PDF in IMSLP_DIR.

    Strategy:
      1. Extract catalog numbers (K/KV, WoO, Op, Hob) from both query AND each PDF name.
      2. If a catalog number matches exactly → strong bonus (0.6).
      3. Also check composer name match → small bonus (0.1).
      4. Fallback: difflib sequence ratio on normalised strings.
    Returns (best_filename, confidence_score, all_pdf_names).
    """
    if not IMSLP_DIR.exists():
        return None, 0.0, []
    pdfs = [f.name for f in sorted(IMSLP_DIR.iterdir()) if f.suffix.lower() == '.pdf']
    if not pdfs:
        return None, 0.0, []

    # Build query catalog numbers from file_name + music_name combined
    query_text = f"{file_name} {music_name}"
    q_nums = _extract_catalog_numbers(query_text)

    # Normalise text for difflib fallback
    def _norm(s: str) -> str:
        s = re.sub(r'IMSLP\d+[-_]?', '', s, flags=re.IGNORECASE)
        s = re.sub(r'PMLP\d+[-_]?', '', s, flags=re.IGNORECASE)
        s = re.sub(r'[_\-\.]+', ' ', s)
        return s.lower().strip()

    q_norm = _norm(query_text)

    best_score = -1.0
    best_file: str | None = None

    for pdf in pdfs:
        stem = pdf[:-4]  # strip .pdf
        p_nums = _extract_catalog_numbers(stem)
        p_norm = _norm(stem)

        # Base: difflib similarity on normalised strings
        score = difflib.SequenceMatcher(None, q_norm, p_norm).ratio()

        # Catalog number exact matches → strong bonus
        for key in ('kv', 'woo', 'op', 'hob'):
            if key in q_nums and key in p_nums and q_nums[key] == p_nums[key]:
                score = min(score + 0.6, 1.0)
                break  # one number match is enough

        # Composer match → bonus or heavy penalty
        # If BOTH query and PDF have a known composer and they differ,
        # cap the score at 0.2 so it never exceeds the 0.3 acceptance
        # threshold — prevents cross-composer mismatches (e.g. Beethoven → Mozart).
        if 'composer' in q_nums and 'composer' in p_nums:
            if q_nums['composer'] == p_nums['composer']:
                score = min(score + 0.1, 1.0)
            else:
                score = score * 0.2  # wrong composer → hard suppress

        if score > best_score:
            best_score = score
            best_file = pdf

    return best_file, round(best_score, 3), pdfs


# ── /api/score/pdf/{file_name} ───────────────────────────────────────

@app.get("/api/score/pdf/{file_name}")
def get_score_pdf(file_name: str):
    """
    Auto-match file_name → best PDF in IMSLP/ and serve it.
    Looks up music_name from TV_annotation for richer matching.
    Returns the PDF file directly (Content-Type: application/pdf).
    If no confident match found, returns 404 JSON.
    """
    # Look up music_name from annotation for richer matching
    music_name = ""
    try:
        df = pd.read_excel(ANNOTATION)
        df["folder"] = df["folder"].ffill()
        col = "file_name (folderName_number)"
        row = df[df[col] == file_name]
        if not row.empty:
            music_name = str(row.iloc[0].get("music_name", ""))
    except Exception:
        pass

    best, score, pdfs = _best_imslp_match(file_name, music_name)

    # Require minimum confidence (catalog number hit gives ~0.6+)
    if best is None or score < 0.3:
        raise HTTPException(
            404,
            detail={
                "matched": False,
                "file_name": file_name,
                "message": "No matching PDF found in IMSLP/",
                "available": pdfs,
            }
        )

    pdf_path = IMSLP_DIR / best
    return FileResponse(
        str(pdf_path),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{best}"',
            "X-Match-Score": str(score),
            "X-Matched-File": best,
        }
    )


# ── /api/score/match ─────────────────────────────────────────────────

@app.get("/api/score/match")
def match_score(file_name: str = "", music_name: str = ""):
    """
    Dry-run version: returns match info without serving the file.
    Returns: { matched, score, pdf_name, available }
    """
    best, score, pdfs = _best_imslp_match(file_name, music_name)
    return {"matched": best is not None, "pdf_name": best, "score": score, "available": pdfs}


# ── MIDI Analysis ────────────────────────────────────────────────────

def _extract_k_number(text: str) -> "str | None":
    """'WAMozart_K265_1' → '265'  (kept for backward compat)"""
    m = re.search(r"[Kk][Vv]?\.?(\d+)", text)
    return m.group(1) if m else None


def _find_midi_file(file_name: str) -> "Path | None":
    """
    Fuzzy-match file_name → .mid in TV_MIDI/.

    Priority:
      1. Exact stem match          LBeethoven_OP34_1  → LBeethoven_OP34_1.mid
      2. K/KV match (Mozart)       WAMozart_K265_1    → "…K.265….mid"
      3. Op match + composer guard LBeethoven_OP34_1  → "…Op.34…Beethoven….mid"
      4. WoO match + composer guard
      5. Hob match (Haydn)
    """
    if not MIDI_DIR.exists():
        return None

    midis = sorted(MIDI_DIR.glob("*.mid"))
    if not midis:
        return None

    # ── 1. Exact stem ────────────────────────────────────────────────────
    exact = MIDI_DIR / f"{file_name}.mid"
    if exact.exists():
        return exact

    # ── 2-5. Catalog-number matching ─────────────────────────────────────
    qn = _extract_catalog_numbers(file_name)

    for p in midis:
        mn = _extract_catalog_numbers(p.stem)

        # K / KV  (Mozart — no composer guard needed, K numbers are unique)
        if qn.get("kv") and qn["kv"] == mn.get("kv"):
            return p

        # Op number  (guard with composer when both sides have one)
        if qn.get("op") and qn["op"] == mn.get("op"):
            qc, mc = qn.get("composer"), mn.get("composer")
            if not qc or not mc or qc == mc:
                return p

        # WoO  (Beethoven catalogue of works without opus)
        if qn.get("woo") and qn["woo"] == mn.get("woo"):
            qc, mc = qn.get("composer"), mn.get("composer")
            if not qc or not mc or qc == mc:
                return p

        # Hob  (Haydn)
        if qn.get("hob") and qn["hob"] == mn.get("hob"):
            return p

    return None


def _parse_midi_analysis(midi_path: "Path", n_variations: int | None = None) -> dict:
    """Parse MIDI → per-variation stats for all 5 structural dimensions.
    n_variations: if provided, divide total_bars into n_variations+1 equal segments
    (Theme + N vars) regardless of annotation lookup or hardcoded fallback.
    """
    if mido is None:
        raise HTTPException(500, "mido not installed. Run: pip install mido")

    mid = mido.MidiFile(str(midi_path))
    tpb = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    # ── Tempo map ──
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

    # ── Collect notes ──
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
                    "onset_sec":  tick2sec(on_t),
                    "pitch":      msg.note,
                    "velocity":   vel,
                    "dur_sec":    max(0.01, tick2sec(abs_t) - tick2sec(on_t)),
                    "beat":       on_t / tpb,
                })

    if not notes:
        raise HTTPException(422, "No notes found in MIDI file")

    notes.sort(key=lambda n: n["beat"])

    def note_bar(n: dict) -> int:
        return int(n["beat"] / beats_per_bar)

    total_bars = max(note_bar(n) for n in notes) + 1

    # ── Variation boundaries ──────────────────────────────────────────────────
    # Strategy (in priority order):
    #   1. Annotation-guided equal division: look up piece in TV_annotation.xlsx
    #      to get section labels and count, then divide total_bars evenly.
    #      This is the most reliable approach: annotations encode ground-truth
    #      structure while MIDI bars are divided proportionally.
    #   2. Hardcoded fallback for K.265 (Theme + 12 Vars × 16 bars each).
    #
    # Note: purely data-driven approaches (note-density valleys, silence gaps,
    # autocorrelation) were evaluated and found unreliable for this genre:
    # each variation deliberately has a different texture/density, so there are
    # no consistent silence gaps or density dips at section boundaries.
    # ─────────────────────────────────────────────────────────────────────────

    seg_method = "fallback"
    var_labels: list[str] = []
    var_starts: list[int] = []

    # ── Strategy 0: MusicXML section markers (highest priority) ──────
    # Reads TextExpression / RehearsalMark nodes directly from the score —
    # these are the composer/editor's own labels (Tema, Var. I, …) so
    # they are exact, not estimated. Works whenever a paired MusicXML file
    # exists (same piece, same measure count as the MIDI).
    midi_stem = midi_path.stem  # use stem to look up MusicXML by same name
    mxml_secs = _get_musicxml_sections(midi_stem)
    if mxml_secs:
        var_labels = [s[0] for s in mxml_secs]
        var_starts = [s[1] for s in mxml_secs]
        seg_method = "musicxml"

    # ── Strategy 1: caller-supplied n_variations ──────────────────────
    # Passed from frontend via ?n_variations=N; used when MusicXML unavailable.
    if not var_labels and n_variations is not None and n_variations >= 1:
        n_segs = n_variations + 1  # Theme + N variations
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_variations + 1)]
        seg_method = "caller"

    # ── Strategy 2: look up annotation (skipped if Strategy 0/1 succeeded) ──
    k_num = _extract_k_number(midi_path.name)
    if not var_labels and k_num and ANNOTATION.exists():
        try:
            ann = pd.read_excel(ANNOTATION)
            # match rows whose file_name contains the K-number
            pat = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
            rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
            if not rows.empty:
                row = rows.iloc[0]
                raw_labels = str(row.get("label", "")).strip()
                # parse label string "[T,V1,V2,...]" → list
                raw_labels = raw_labels.strip("[]").replace("'", "").replace('"', "")
                seg_labels_raw = [s.strip() for s in raw_labels.split(",") if s.strip()]
                # normalise labels: T→Theme, V1→Var.01, C→Coda
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
                    # Divide total_bars evenly; last segment absorbs remainder
                    step = total_bars / n_segs
                    var_starts = [round(i * step) for i in range(n_segs)]
                    var_labels = seg_labels_raw
                    seg_method = "annotation"
        except Exception:
            pass  # fall through to fallback

    # ── Strategy 3: hardcoded fallback ──
    if not var_labels:
        theme_bars = 16
        var_bars   = 16
        var_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, 13)]
        var_starts = [0] + [theme_bars + i * var_bars for i in range(12)]
        seg_method = "fallback"

    var_ends = var_starts[1:] + [total_bars]

    def notes_in(s: int, e: int) -> list[dict]:
        return [n for n in notes if s <= note_bar(n) < e]

    # Helpers
    KS_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]
    KS_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]
    main_tempo = tempo_map[1][1] if len(tempo_map) > 1 else 500_000
    beat_dur   = main_tempo / 1_000_000  # seconds per beat

    mel_mean, mel_lo, mel_hi = [], [], []
    stp_r, lp_r, mean_iv     = [], [], []
    harm_t, harm_d, harm_s   = [], [], []
    vel_mean_l, vel_std_l    = [], []
    rhy_quarter, rhy_8th, rhy_16th, rhy_32nd = [], [], [], []
    chroma_list: list[list[float]] = []
    key_root_l:  list[int]         = []
    key_mode_l:  list[str]         = []

    for s, e in zip(var_starts, var_ends):
        nl = notes_in(s, e)

        # ── Melodic contour ──
        if nl:
            bb: dict = collections.defaultdict(list)
            for n in nl:
                bb[round(n["beat"] * 2) / 2].append(n["pitch"])
            tops = [max(v) for v in bb.values()]
            tops_sorted = sorted(tops)
            p10 = tops_sorted[max(0, int(len(tops_sorted) * 0.10))]
            p90 = tops_sorted[min(len(tops_sorted)-1, int(len(tops_sorted) * 0.90))]
            mel_mean.append(round(sum(tops) / len(tops), 1))
            mel_lo.append(p10)
            mel_hi.append(p90)
        else:
            mel_mean.append(60); mel_lo.append(60); mel_hi.append(60)

        # ── Interval motion ──
        ps = [n["pitch"] for n in sorted(nl, key=lambda n: n["beat"])]
        ivs = [abs(ps[i+1]-ps[i]) for i in range(len(ps)-1)]
        if ivs:
            stp_r.append(round(sum(1 for v in ivs if v <= 2) / len(ivs), 3))
            lp_r.append(round(sum(1 for v in ivs if v > 4) / len(ivs), 3))
            mean_iv.append(round(sum(ivs) / len(ivs), 2))
        else:
            stp_r.append(0); lp_r.append(0); mean_iv.append(0)

        # ── Chroma + key detection (Krumhansl-Schmuckler) ──
        pc_raw = [0.0] * 12
        for n in nl:
            pc_raw[n["pitch"] % 12] += 1
        s_pc = sum(pc_raw) or 1
        pc = [v / s_pc for v in pc_raw]           # normalised 0-1

        # KS correlation for all 24 keys → pick best
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

        # Functional harmony (relative to detected key root)
        root = best_root
        if best_mode_v == "major":
            t_pcs  = {root % 12, (root + 4) % 12, (root + 7) % 12}   # I
            d_pcs  = {(root + 7) % 12, (root + 11) % 12, (root + 2) % 12}  # V
            su_pcs = {(root + 5) % 12, (root + 9) % 12, root % 12}   # IV
        else:
            t_pcs  = {root % 12, (root + 3) % 12, (root + 7) % 12}   # i
            d_pcs  = {(root + 7) % 12, (root + 11) % 12, (root + 2) % 12}  # V
            su_pcs = {(root + 5) % 12, (root + 8) % 12, root % 12}   # iv
        t_  = sum(pc[p] for p in t_pcs)
        d_  = sum(pc[p] for p in d_pcs)
        su_ = sum(pc[p] for p in su_pcs)
        td  = t_ + d_ + su_ or 1
        harm_t.append(round(t_ / td, 3))
        harm_d.append(round(d_ / td, 3))
        harm_s.append(round(su_ / td, 3))

        # ── Rhythmic ratios ──
        rq = re = rs = rt = 0
        for n in nl:
            r = n["dur_sec"] / beat_dur
            if   r >= 0.75: rq += 1
            elif r >= 0.37: re += 1
            elif r >= 0.18: rs += 1
            else:           rt += 1
        tot = rq + re + rs + rt or 1
        rhy_quarter.append(round(rq/tot, 3))
        rhy_8th.append(round(re/tot, 3))
        rhy_16th.append(round(rs/tot, 3))
        rhy_32nd.append(round(rt/tot, 3))

        # ── Dynamics ──
        vels = [n["velocity"] for n in nl] or [64]
        mean_v = sum(vels) / len(vels)
        std_v  = math.sqrt(sum((v - mean_v)**2 for v in vels) / len(vels))
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


# ── Local score corpus (VariVis/scores/) ────────────────────────────
SCORES_DIR = BASE_DIR / "scores"
SCORES_DIR.mkdir(exist_ok=True)

# Map file_name prefix → expected stem inside scores/
# Convention: mozart_k265, beethoven_woo67, beethoven_op35, haydn_hob17_6
_SCORE_MAP: dict[str, str] = {
    # ── Beethoven WoO ──────────────────────────────────────────────
    "LBeethoven_WOO28":  "beethoven_woo28",
    "LBeethoven_WOO40":  "beethoven_woo40",
    "LBeethoven_WOO45":  "beethoven_woo45",
    "LBeethoven_WOO63":  "beethoven_woo63",
    "LBeethoven_WOO64":  "beethoven_woo64",
    "LBeethoven_WOO65":  "beethoven_woo65",
    "LBeethoven_WOO66":  "beethoven_woo66",
    "LBeethoven_WOO67":  "beethoven_woo67",
    "LBeethoven_WOO68":  "beethoven_woo68",
    "LBeethoven_WOO69":  "beethoven_woo69",
    "LBeethoven_WOO70":  "beethoven_woo70",
    "LBeethoven_WOO71":  "beethoven_woo71",
    "LBeethoven_WOO72":  "beethoven_woo72",
    "LBeethoven_WOO73":  "beethoven_woo73",
    "LBeethoven_WOO74":  "beethoven_woo74",
    "LBeethoven_WOO75":  "beethoven_woo75",
    "LBeethoven_WOO76":  "beethoven_woo76",
    "LBeethoven_WOO77":  "beethoven_woo77",
    "LBeethoven_WOO78":  "beethoven_woo78",
    "LBeethoven_WOO79":  "beethoven_woo79",
    "LBeethoven_WOO80":  "beethoven_woo80",
    # ── Beethoven Op ───────────────────────────────────────────────
    "LBeethoven_OP34":   "beethoven_op34",
    "LBeethoven_OP35":   "beethoven_op35",
    "LBeethoven_OP66":   "beethoven_op66",
    "LBeethoven_OP76":   "beethoven_op76",
    "LBeethoven_OP105":  "beethoven_op105",
    "LBeethoven_OP120":  "beethoven_op120",
    "LBeethoven_OP121":  "beethoven_op121a",
    # ── Mozart K ───────────────────────────────────────────────────
    "WAMozart_K24":      "mozart_k24",
    "WAMozart_K25":      "mozart_k25",
    "WAMozart_K54":      "mozart_k54",
    "WAMozart_K179":     "mozart_k179",
    "WAMozart_K180":     "mozart_k180",
    "WAMozart_K264":     "mozart_k264",
    "WAMozart_K265":     "mozart_k265",
    "WAMozart_K352":     "mozart_k352",
    "WAMozart_K353":     "mozart_k353",
    "WAMozart_K354":     "mozart_k354",
    "WAMozart_K398":     "mozart_k398",
    "WAMozart_K455":     "mozart_k455",
    "WAMozart_K460":     "mozart_k460",
    "WAMozart_K500":     "mozart_k500",
    "WAMozart_K501":     "mozart_k501",
    "WAMozart_K573":     "mozart_k573",
    "WAMozart_K613":     "mozart_k613",
    # ── Haydn Hob.XVII ────────────────────────────────────────────
    "JHaydn_XVII2":      "haydn_hob17_2",
    "JHaydn_XVII3":      "haydn_hob17_3",
    "JHaydn_XVII5":      "haydn_hob17_5",
    "JHaydn_XVII6":      "haydn_hob17_6",
    "JHaydn_XVII7":      "haydn_hob17_7",
}


def _find_local_score(file_name: str) -> "Path | None":
    """
    Match file_name to a local .mxl / .xml / .musicxml in SCORES_DIR.
    Strips the trailing _N performer index before looking up the map.
    e.g. 'WAMozart_K265_3' → key 'WAMozart_K265' → 'mozart_k265'
         → checks scores/mozart_k265.mxl, scores/mozart_k265.xml, ...
    """
    # Strip trailing _<digits> (performer index)
    base = re.sub(r"_\d+$", "", file_name)
    stem = _SCORE_MAP.get(base)
    if stem is None:
        return None
    for ext in (".mxl", ".xml", ".musicxml"):
        p = SCORES_DIR / f"{stem}{ext}"
        if p.exists():
            return p
    return None


def _score_cache_path(file_name: str) -> Path:
    """Deterministic cache path in SCORES_DIR for converted XML."""
    base = re.sub(r"_\d+$", "", file_name)
    stem = _SCORE_MAP.get(base, base.lower())
    return SCORES_DIR / f"{stem}.cached.xml"


@app.get("/api/score/musicxml/{file_name}")
def get_musicxml(file_name: str):
    """
    Serve MusicXML for a piece.  Priority:
      1. scores/<stem>.cached.xml  — previously converted, served instantly
      2. scores/<stem>.mxl/.xml    — user-placed IMSLP file, parse via music21
      3. TV_MIDI/<matched>.mid     — fallback: MIDI → MusicXML via music21
    Returns { matched, source, xml } or { matched: false, message, available_stems }
    """
    import music21

    cache = _score_cache_path(file_name)

    # ── 1. Cached XML ────────────────────────────────────────────────
    if cache.exists():
        return {
            "matched": True,
            "source":  "cache",
            "file_name": file_name,
            "xml": cache.read_text(encoding="utf-8"),
        }

    # ── 2. Local IMSLP MXL ──────────────────────────────────────────
    local = _find_local_score(file_name)
    if local is not None:
        try:
            score    = music21.converter.parse(str(local))
            exporter = music21.musicxml.m21ToXml.GeneralObjectExporter(score)
            xml_bytes = exporter.parse()
            xml_str   = xml_bytes.decode("utf-8", errors="replace")
            cache.write_text(xml_str, encoding="utf-8")
            return {
                "matched":   True,
                "source":    f"imslp:{local.name}",
                "file_name": file_name,
                "xml":       xml_str,
            }
        except Exception as e:
            raise HTTPException(500, f"music21 parse failed for {local.name}: {e}")

    # ── 3. MIDI fallback ─────────────────────────────────────────────
    midi_path = _find_midi_file(file_name)
    if midi_path is not None:
        try:
            score    = music21.converter.parse(str(midi_path))
            exporter = music21.musicxml.m21ToXml.GeneralObjectExporter(score)
            xml_bytes = exporter.parse()
            xml_str   = xml_bytes.decode("utf-8", errors="replace")
            cache.write_text(xml_str, encoding="utf-8")
            return {
                "matched":   True,
                "source":    f"midi:{midi_path.name}",
                "file_name": file_name,
                "xml":       xml_str,
            }
        except Exception as e:
            raise HTTPException(500, f"music21 MIDI conversion failed: {e}")

    # ── 4. Nothing found ─────────────────────────────────────────────
    base      = re.sub(r"_\d+$", "", file_name)
    stem      = _SCORE_MAP.get(base)
    return {
        "matched":        False,
        "file_name":      file_name,
        "expected_file":  f"scores/{stem}.mxl" if stem else None,
        "message": (
            f"No score found. Place the MusicXML file at scores/{stem}.mxl"
            if stem else
            f"'{file_name}' is not in the score map."
        ),
    }


@app.get("/api/score/mxl_notes/{file_name}")
def get_mxl_notes(file_name: str):
    """
    Extract notes directly from MusicXML for in-browser Tone.js synthesis.

    Returns:
      { available: false }                         — no MusicXML found
      { available: true, tempo_bpm, notes, segments }  — success

    notes:    [{ pitch, start_sec, dur_sec, velocity }]
    segments: [{ label, start_sec, end_sec }]
    """
    path = _find_musicxml(file_name)
    if path is None:
        return {"available": False}

    try:
        import music21
    except ImportError:
        return {"available": False}

    try:
        if path.suffix.lower() == ".mxl":
            xml_bytes = _extract_mxl(path)
            score = music21.converter.parseData(xml_bytes, format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception as e:
        return {"available": False, "error": str(e)}

    # ── Tempo ────────────────────────────────────────────────────────────
    tempo_bpm = 120.0
    for el in score.flatten():
        if isinstance(el, music21.tempo.MetronomeMark) and el.number:
            tempo_bpm = float(el.number)
            break
    sec_per_qn = 60.0 / tempo_bpm   # seconds per quarter note

    # ── Notes (all parts flattened, highest-velocity wins per-pitch per slot) ──
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

    # ── Segment boundaries from rehearsal / section marks ───────────────
    mxml_secs = _get_musicxml_sections(file_name)   # [(label, measure_idx), ...]
    segments: list[dict] = []

    if mxml_secs:
        # Map measure index → offset in quarter notes
        part0    = score.parts[0] if score.parts else None
        measures = list(part0.getElementsByClass("Measure")) if part0 else []
        idx_to_qn: dict[int, float] = {}
        for mi, m in enumerate(measures):
            idx_to_qn[mi] = float(m.offset)
        total_dur_sec = max((n["start_sec"] + n["dur_sec"] for n in raw_notes), default=0.0)

        for si, (label, m_idx) in enumerate(mxml_secs):
            start_qn  = idx_to_qn.get(m_idx, 0.0)
            start_sec = round(start_qn * sec_per_qn, 3)
            if si + 1 < len(mxml_secs):
                next_qn  = idx_to_qn.get(mxml_secs[si + 1][1], start_qn)
                end_sec  = round(next_qn * sec_per_qn, 3)
            else:
                end_sec  = round(total_dur_sec, 3)
            segments.append({"label": label, "start_sec": start_sec, "end_sec": end_sec})
    else:
        # No section marks — expose whole piece as a single segment
        total_dur_sec = max((n["start_sec"] + n["dur_sec"] for n in raw_notes), default=0.0)
        segments = [{"label": "Full", "start_sec": 0.0, "end_sec": round(total_dur_sec, 3)}]

    return {
        "available": True,
        "tempo_bpm": round(tempo_bpm, 2),
        "notes":     raw_notes,
        "segments":  segments,
    }

# ── MusicVis endpoints ───────────────────────────────────────────────

# Circle-of-fifths pitch-class order: C G D A E B F# Db Ab Eb Bb F
_COF_ORDER = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
_COF_NAMES = ["C","G","D","A","E","B","F#","Db","Ab","Eb","Bb","F"]

def _find_musicxml(file_name: str):
    """Match file_name to a .mxl/.xml file in MUSICXML_DIR.

    Accepts both plain stems ("WAMozart_K265") and:
      • filenames with extension ("WAMozart_K265.mxl")
      • piece names with version suffix ("WAMozart_K265_1")
    """
    # Strip extension if present, then strip trailing version index (_1, _2 …)
    base = Path(file_name).stem if "." in file_name else file_name
    stems = [base, re.sub(r"_\d+$", "", base)]  # try with and without version suffix
    for stem in stems:
        stem = stem.replace(" ", "_")
        for ext in (".mxl", ".xml", ".musicxml"):
            p = MUSICXML_DIR / f"{stem}{ext}"
            if p.exists():
                return p
    # fuzzy: case-insensitive stem match
    for f in MUSICXML_DIR.iterdir():
        if f.suffix.lower() in (".mxl", ".xml", ".musicxml"):
            for stem in stems:
                if f.stem.lower() == stem.replace(" ", "_").lower():
                    return f
    return None


def _get_musicxml_sections(file_name: str) -> "list[tuple[str,int]]":
    """
    Parse MusicXML for file_name and return section boundaries as
    [(label, measure_index), ...] sorted by measure index.
    Returns [] if no MusicXML found, music21 unavailable, or <2 sections detected.
    This is the single source of truth for Theme/Var segmentation used by
    both the Piano Roll (get_midi_notes) and MIDI analysis (_parse_midi_analysis).
    """
    path = _find_musicxml(file_name)
    if path is None:
        return []
    try:
        import music21
    except ImportError:
        return []

    try:
        if path.suffix.lower() == ".mxl":
            xml_bytes = _extract_mxl(path)
            score = music21.converter.parseData(xml_bytes, format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception:
        return []

    if not score.parts:
        return []

    part    = score.parts[0]
    measures = list(part.getElementsByClass("Measure"))
    total    = len(measures)

    offset_to_idx: dict[float, int] = {}
    for idx, m in enumerate(measures):
        off = float(m.offset)
        if off not in offset_to_idx:
            offset_to_idx[off] = idx

    _SKIP = ("m.s.", "m.d.", "destra", "sinistra", "ritard", "fine", "segue",
             "rit.", "poco", "sempre", "cresc", "decresc", "dim.", "sfz", "fz",
             "p.", "dolce", "legato", "staccato", "andantino", "andante",
             "allegro", "adagio", "moderato", "presto", "vivace", "largo", "lento")

    raw: list[tuple[float, str]] = []
    seen: set[float] = set()
    for m in measures:
        off = float(m.offset)
        if off in seen:
            continue
        seen.add(off)
        for el in m.flatten():
            if isinstance(el, (music21.expressions.RehearsalMark,
                                music21.expressions.TextExpression)):
                content = (el.content if hasattr(el, "content") else str(el)).strip()
                if not content:
                    continue
                low = content.lower()
                if any(k in low for k in _SKIP):
                    continue
                if low.startswith(("tema", "var", "theme", "coda",
                                   "finale", "minore", "maggiore", "trio")):
                    raw.append((off, content))
                    break

    raw.sort(key=lambda x: x[0])

    # Auto-prepend Tema if first marker doesn't start at measure 0
    if raw and offset_to_idx.get(raw[0][0], 0) > 0:
        raw.insert(0, (0.0, "Tema"))

    if len(raw) < 2:
        return []

    _ROMAN = {"i":1,"ii":2,"iii":3,"iv":4,"v":5,"vi":6,
              "vii":7,"viii":8,"ix":9,"x":10,"xi":11,"xii":12}

    def _roman_to_int(s: str) -> int | None:
        t = s.strip().lower()
        return _ROMAN.get(t)

    result = []
    for off, label in raw:
        idx = offset_to_idx.get(off, 0)
        low = label.lower()
        if low in ("tema", "theme"):
            norm = "Theme"
        elif low.startswith("coda"):
            norm = "Coda"
        else:
            # Try Arabic digits first ("VAR. 3", "Variation 12")
            m2 = re.search(r"(\d+)", label)
            if m2:
                norm = f"Var.{int(m2.group(1)):02d}"
            else:
                # Try Roman numerals ("VAR. I", "VAR. VIII")
                m3 = re.search(r"[.\s]+([IVXivx]+)\s*$", label)
                n = _roman_to_int(m3.group(1)) if m3 else None
                norm = f"Var.{n:02d}" if n else label
        result.append((norm, idx))

    return result


@app.get("/api/musicvis/list")
def list_musicxml():
    """List all MusicXML files available in MusicXML/."""
    files = []
    for f in sorted(MUSICXML_DIR.iterdir()):
        if f.suffix.lower() in (".mxl", ".xml", ".musicxml"):
            files.append(f.stem)
    return {"files": files}

def _extract_mxl(path) -> bytes:
    """Extract the score XML bytes from an .mxl (ZIP) file.

    .mxl structure (MusicXML spec):
      META-INF/container.xml  → lists the rootfile full-path
      <rootfile full-path>    → actual MusicXML score
    """
    import zipfile, xml.etree.ElementTree as ET
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        # 1) Try to read META-INF/container.xml for the canonical rootfile path
        if "META-INF/container.xml" in names:
            container = zf.read("META-INF/container.xml")
            try:
                root = ET.fromstring(container)
                ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
                rf = root.find(".//c:rootfile", ns) or root.find(".//rootfile")
                if rf is not None:
                    rootfile_path = rf.get("full-path")
                    if rootfile_path and rootfile_path in names:
                        return zf.read(rootfile_path)
            except ET.ParseError:
                pass
        # 2) Fallback: pick the first .xml that isn't inside META-INF/
        for n in names:
            if n.endswith(".xml") and not n.startswith("META-INF"):
                return zf.read(n)
        # 3) Last resort: first entry
        return zf.read(names[0])

@app.get("/api/musicvis/xml/{file_name}")
def serve_musicxml_raw(file_name: str):
    """Serve the raw MusicXML (as text/xml) for OSMD to load directly."""
    path = _find_musicxml(file_name)
    if path is None:
        raise HTTPException(404, f"No MusicXML found for {file_name} in MusicXML/")
    if path.suffix.lower() == ".mxl":
        xml_bytes = _extract_mxl(path)
        return Response(content=xml_bytes, media_type="text/xml")
    else:
        return Response(content=path.read_bytes(), media_type="text/xml")

@app.get("/api/musicvis/sections/{file_name}")
def get_musicvis_sections(file_name: str):
    """
    Parse MusicXML and return section boundaries (Theme, Var. I, …) as
    global 0-based measure indices (matching OSMD's sequential draw order).
    Returns:
      sections: [{ label, start_idx, end_idx }]  end_idx is exclusive
    """
    path = _find_musicxml(file_name)
    if path is None:
        raise HTTPException(404, f"No MusicXML found for {file_name} in MusicXML/")
    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    try:
        if path.suffix.lower() == ".mxl":
            xml_bytes = _extract_mxl(path)
            score = music21.converter.parseData(xml_bytes, format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception as e:
        raise HTTPException(500, f"music21 parse error: {e}")

    # Use first part to scan for TextExpression / RehearsalMark section markers
    if not score.parts:
        return {"sections": []}

    part = score.parts[0]
    measures = list(part.getElementsByClass("Measure"))
    total = len(measures)

    # Build offset → global index map
    offset_to_idx: dict[float, int] = {}
    for idx, m in enumerate(measures):
        off = float(m.offset)
        if off not in offset_to_idx:
            offset_to_idx[off] = idx

    # Collect section markers (skip pure performance directions)
    _SKIP_KEYWORDS = ("m.s.", "m.d.", "destra", "sinistra", "ritard",
                      "fine", "segue", "rit.", "poco", "sempre", "cresc",
                      "decresc", "dim.", "sfz", "fz", "p.", "dolce", "legato",
                      "staccato", "andantino", "andante", "allegro", "adagio",
                      "moderato", "presto", "vivace", "largo", "lento")

    raw_sections: list[tuple[float, str]] = []  # (offset, label)
    seen_offsets: set[float] = set()

    for m in measures:
        off = float(m.offset)
        if off in seen_offsets:
            continue
        seen_offsets.add(off)
        for el in m.flatten():
            if isinstance(el, (music21.expressions.RehearsalMark,
                                music21.expressions.TextExpression)):
                content = (el.content if hasattr(el, "content") else str(el)).strip()
                if not content:
                    continue
                low = content.lower()
                if any(k in low for k in _SKIP_KEYWORDS):
                    continue
                # Only keep section-level markers (Tema, Var., Coda, etc.)
                if (low.startswith(("tema", "var", "theme", "coda",
                                    "finale", "minore", "maggiore", "trio"))):
                    raw_sections.append((off, content))
                    break  # one marker per measure offset

    # Sort by offset, resolve start/end indices
    raw_sections.sort(key=lambda x: x[0])

    # Auto-prepend a "Tema" entry when the first detected marker doesn't start at
    # measure 0 (e.g. scores like K265 that have no "Tema" text expression but do
    # have a theme before "VAR. I").
    if raw_sections and offset_to_idx.get(raw_sections[0][0], 0) > 0:
        raw_sections.insert(0, (0.0, "Tema"))

    sections = []
    for i, (off, label) in enumerate(raw_sections):
        start_idx = offset_to_idx.get(off, 0)
        if i + 1 < len(raw_sections):
            next_off = raw_sections[i + 1][0]
            end_idx = offset_to_idx.get(next_off, total)
        else:
            end_idx = total
        norm = label
        sections.append({"label": label, "norm": norm,
                          "start_idx": start_idx, "end_idx": end_idx})

    return {"matched": True, "file_name": file_name, "sections": sections,
            "total_measures": total}


def _degree_to_function(degree: int) -> str:
    """Map scale degree 1-7 to harmonic function T/S/D/O."""
    return {1: 'T', 2: 'S', 3: 'T', 4: 'S', 5: 'D', 6: 'T', 7: 'D'}.get(degree, 'O')


@app.get("/api/musicvis/chords/{file_name}")
def get_musicvis_chords(file_name: str):
    """
    Parse MusicXML with music21, chordify per measure, classify into T/S/D/O.
    Returns per-measure: { seq, function, chord, T, S, D, O }
    where T/S/D/O are duration-weighted fractions summing to 1.
    """
    path = _find_musicxml(file_name)
    if path is None:
        raise HTTPException(404, f"No MusicXML found for {file_name}")
    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    try:
        if path.suffix.lower() == ".mxl":
            xml_bytes = _extract_mxl(path)
            score = music21.converter.parseData(xml_bytes, format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception as e:
        raise HTTPException(500, f"music21 parse error: {e}")

    # Key detection
    try:
        key_obj = score.analyze('key')
    except Exception:
        key_obj = music21.key.Key('C')

    # Chordify — collapse all parts into simultaneous chords
    try:
        chordified = score.chordify()
    except Exception as e:
        raise HTTPException(500, f"chordify error: {e}")

    results = []
    chord_measures = list(chordified.getElementsByClass("Measure"))

    for seq_idx, measure in enumerate(chord_measures):
        weights: dict[str, float] = {'T': 0.0, 'S': 0.0, 'D': 0.0, 'O': 0.0}
        best_chord, best_dur = '?', 0.0

        for c in measure.getElementsByClass('Chord'):
            dur = float(c.duration.quarterLength)
            if dur < 0.25:          # skip passing-tone chords < 1 sixteenth note
                continue
            try:
                rn  = music21.roman.romanNumeralFromChord(c, key_obj)
                fn  = _degree_to_function(rn.scaleDegree)
                lbl = rn.figure
            except Exception:
                fn, lbl = 'O', '?'

            weights[fn] += dur
            if dur > best_dur:
                best_dur, best_chord = dur, lbl

        total = sum(weights.values()) or 1.0
        dominant_fn = max(weights, key=weights.get)

        results.append({
            "seq":      seq_idx,
            "function": dominant_fn,
            "chord":    best_chord,
            "T": round(weights['T'] / total, 3),
            "S": round(weights['S'] / total, 3),
            "D": round(weights['D'] / total, 3),
            "O": round(weights['O'] / total, 3),
        })

    return {
        "matched":  True,
        "key":      str(key_obj),
        "mode":     key_obj.mode,
        "tonic":    key_obj.tonic.name,
        "measures": results,
        "total":    len(results),
    }


# ─── Skeleton melody extraction ───────────────────────────────────────────────

def _metric_weight(beat_offset: float, ts_num: int) -> float:
    """Metric weight for a beat offset (in quarter-note units) within a measure."""
    b = beat_offset
    if b == 0.0:
        return 4.0                              # downbeat
    half = ts_num / 2.0
    if ts_num >= 4 and abs(b - half) < 0.05:
        return 2.0                              # mid-bar (beat 3 in 4/4)
    if abs(b - round(b)) < 0.05:
        return 1.0                              # on-beat
    return 0.5                                  # subdivision


def _pc(midi: int) -> int:
    return midi % 12


def _step_interval(a: int, b: int) -> bool:
    """True if the chromatic interval between two pitch classes is a semitone or whole tone."""
    return min((b - a) % 12, (a - b) % 12) in (1, 2)


def _extract_top_voice(measures: list, start_idx: int, end_idx: int) -> list:
    """
    For measures[start_idx:end_idx] (from the top part), collect the highest-sounding
    pitch at each distinct beat offset within each measure.
    Returns list of dicts: {measure_rel, beat, pc, midi, duration, metric_weight}.
    """
    result = []
    for rel, m in enumerate(measures[start_idx:end_idx]):
        ts  = m.getContextByClass('TimeSignature')
        ts_num = ts.numerator if ts else 4

        # Group all note onsets by beat offset → [(midi, duration)]
        beat_notes: dict = {}
        for el in m.recurse().notesAndRests:
            beat = float(el.offset)
            dur  = float(el.duration.quarterLength)
            if hasattr(el, 'pitch'):
                beat_notes.setdefault(beat, []).append((el.pitch.midi, dur))
            elif hasattr(el, 'pitches'):
                for p in el.pitches:
                    beat_notes.setdefault(beat, []).append((p.midi, dur))

        for beat in sorted(beat_notes.keys()):
            top_midi, top_dur = max(beat_notes[beat], key=lambda x: x[0])
            result.append({
                'measure_rel':   rel,
                'beat':          beat,
                'pc':            _pc(top_midi),
                'midi':          top_midi,
                'duration':      top_dur,
                'metric_weight': _metric_weight(beat, ts_num),
            })
    return result


def _remove_ornaments(notes: list) -> list:
    """
    Middleground-level filtering: only remove notes that are ALL of:
      • on a very weak beat (metric_weight == 0.5, i.e. subdivision)
      • extremely short (< 0.25 quarter notes, i.e. sixteenth note or less)
      • form clear passing or neighbor motion with neighbours
    Notes on beats (weight >= 1.0) and all longer notes are always kept,
    so roughly every beat-1 and beat-3 position survives → ~1-2 notes per measure.
    """
    if len(notes) < 3:
        return notes
    keep = [True] * len(notes)
    for i in range(1, len(notes) - 1):
        n = notes[i]
        # Keep anything on a real beat or stronger
        if n['metric_weight'] >= 1.0:
            continue
        # Keep anything lasting at least a sixteenth note
        if n['duration'] >= 0.25:
            continue

        prev_pc = notes[i - 1]['pc']
        curr_pc = n['pc']
        next_pc = notes[i + 1]['pc']

        step_in  = _step_interval(prev_pc, curr_pc)
        step_out = _step_interval(curr_pc, next_pc)
        same_dir = (((curr_pc - prev_pc) % 12 < 6) == ((next_pc - curr_pc) % 12 < 6))
        passing  = step_in and step_out and same_dir
        neighbor = step_in and step_out and (prev_pc == next_pc)

        if passing or neighbor:
            keep[i] = False

    return [n for n, k in zip(notes, keep) if k]


def _build_chord_lookup(score) -> list:
    """
    Build a sorted list of (abs_quarter_offset, frozenset_of_pitch_classes)
    by chordifying the full score.  Used to decide whether a note is a chord tone.
    Returns [] on failure so callers can degrade gracefully.
    """
    try:
        cf = score.chordify().flatten()
        import music21
        lookup = []
        for el in cf.getElementsByClass('Chord'):
            pcs = frozenset(p.midi % 12 for p in el.pitches)
            lookup.append((float(el.offset), pcs))
        lookup.sort(key=lambda x: x[0])
        return lookup
    except Exception:
        return []


def _chord_pcs_at(lookup: list, abs_offset: float) -> frozenset:
    """Return the pitch-class set of the chord active at abs_offset."""
    pcs: frozenset = frozenset()
    for b, p in lookup:
        if b <= abs_offset + 0.02:
            pcs = p
        else:
            break
    return pcs


def _edge_type_cost(pc_i: int, midi_i: int, pc_j: int, midi_j: int,
                    chord_pcs_i: frozenset, chord_pcs_j: frozenset) -> float:
    """
    Tonal cost of edge xi → xj, following Wang et al. (ISMIR 2025).

    Edge types (in priority order):
      PE  – Prolongational:  same pitch          → 0.10
      LE  – Linear:          chromatic 2nd        → 0.30
      IPE – Imaginary prol.: same pitch class     → 1.00
      ILE – Imaginary lin.:  compound 2nd         → 1.30
      AE  – Arpeggiation:    same chord, >2nd     → 1.50
      UE  – Unclassified                          → 3.00
    """
    if midi_i == midi_j:
        return 0.10   # PE
    interval = min((pc_j - pc_i) % 12, (pc_i - pc_j) % 12)
    if interval in (1, 2):
        return 0.30   # LE
    if pc_i == pc_j:
        return 1.00   # IPE
    if interval in (1, 2, 10, 11):
        return 1.30   # ILE  (compound second via inversion)
    if chord_pcs_i and chord_pcs_j and pc_i in chord_pcs_i and pc_j in chord_pcs_j:
        return 1.50   # AE
    return 3.00        # UE


def _note_importance(n: dict, pitch_min: int, pitch_max: int,
                     chord_pcs: frozenset) -> float:
    """
    Note importance factor α(x) = αp · αo · αd · αh  (Wang et al. 2025).
    Smaller value → note is more important → lower edge cost → more likely selected.
    """
    # αp: pitch extremes are more important
    p_mid = (pitch_min + pitch_max) / 2.0
    p_range = max(pitch_max - pitch_min, 1)
    alpha_p = 0.1 * (0.5 - abs(n['midi'] - p_mid) / p_range) + 1.0

    # αo: metric position
    mw = n['metric_weight']
    if mw >= 4.0:   alpha_o = 0.85   # downbeat
    elif mw >= 2.0: alpha_o = 0.90   # mid-bar
    elif mw >= 1.0: alpha_o = 0.95   # on-beat
    else:           alpha_o = 1.10   # subdivision

    # αd: duration importance
    dur = n['duration']
    if dur >= 2.0:   alpha_d = 0.85   # half note or longer
    elif dur >= 1.0: alpha_d = 0.95   # quarter note
    elif dur >= 0.5: alpha_d = 1.05   # eighth note
    else:            alpha_d = 1.15   # sixteenth or shorter

    # αh: harmony – chord tone preferred
    alpha_h = 0.85 if (chord_pcs and n['pc'] in chord_pcs) else 1.15

    return alpha_p * alpha_o * alpha_d * alpha_h


def _shortest_path_skeleton(voice: list, chord_lookup: list,
                             beats_per_measure: float = 4.0,
                             max_measure_span: int = 2) -> list:
    """
    Graph-based melody reduction following Wang et al. (ISMIR 2025).

    Nodes  : notes in `voice` (output of _extract_top_voice)
    Edges  : all forward pairs (i→j) within max_measure_span measures
    Cost   : c(i→j) = α(j) * [c_tonal(i→j) + c_temporal(i→j)]
    Result : Dijkstra shortest path → skeleton note indices
    η      : temporal cost exponent (1.6 per paper; controls reduction density)
    """
    import heapq

    if len(voice) <= 2:
        return voice[:]

    N = len(voice)
    pitch_min = min(n['midi'] for n in voice)
    pitch_max = max(n['midi'] for n in voice)
    eta = 1.6   # temporal exponent from paper

    # Pre-compute absolute beat offset for each note (measure_rel * bpm + beat)
    abs_beats = [n['measure_rel'] * beats_per_measure + n['beat'] for n in voice]

    # Pre-compute chord PCs at each note's position
    note_chord_pcs = [_chord_pcs_at(chord_lookup, ab) for ab in abs_beats]

    # Pre-compute importance weights
    importance = [
        _note_importance(voice[i], pitch_min, pitch_max, note_chord_pcs[i])
        for i in range(N)
    ]

    # Build adjacency list with costs
    # Edge xi → xj exists if 0 < j-i and measure span ≤ max_measure_span
    adj: list[list[tuple[float, int]]] = [[] for _ in range(N)]
    for i in range(N):
        for j in range(i + 1, N):
            span = voice[j]['measure_rel'] - voice[i]['measure_rel']
            if span > max_measure_span:
                break
            steps = j - i
            c_tonal = _edge_type_cost(
                voice[i]['pc'], voice[i]['midi'],
                voice[j]['pc'], voice[j]['midi'],
                note_chord_pcs[i], note_chord_pcs[j]
            )
            c_temp = steps ** eta
            cost = importance[j] * (c_tonal + c_temp)
            adj[i].append((cost, j))

    # Dijkstra from node 0 to node N-1
    INF = float('inf')
    dist = [INF] * N
    prev = [-1]  * N
    dist[0] = 0.0
    heap = [(0.0, 0)]

    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u]:
            continue
        for cost, v in adj[u]:
            nd = d + cost
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))

    # Reconstruct path
    path = []
    cur = N - 1
    while cur != -1:
        path.append(cur)
        cur = prev[cur]
    path.reverse()

    # If path doesn't reach end (disconnected graph), fall back to all notes
    if path[0] != 0:
        return voice[:]

    return [voice[i] for i in path]


def _extract_skeleton_level(score, start_idx: int, end_idx: int, key_obj,
                             min_metric_weight: float = 0.0,
                             max_measure_span: int = 2) -> list:
    """
    Extract skeleton at a specific structural level by pre-filtering the top
    voice to notes whose metric_weight >= min_metric_weight before Dijkstra.

    Structural levels:
      min_weight=0.0, span=2 → foreground  (~1-2 notes/measure, all beat positions)
      min_weight=2.0, span=4 → midground   (~1 note/phrase, strong beats only: ♩1 & ♩3 in 4/4)
      min_weight=4.0, span=8 → background  (~3-5 notes/section, downbeats only)
    """
    parts = score.parts
    if not parts:
        return []
    top_part = parts[0]
    measures  = list(top_part.getElementsByClass('Measure'))
    end_idx   = min(end_idx, len(measures))

    voice = _extract_top_voice(measures, start_idx, end_idx)
    if not voice:
        return []

    if min_metric_weight <= 0.0:
        voice = _remove_ornaments(voice)
    else:
        voice = [n for n in voice if n['metric_weight'] >= min_metric_weight]

    if len(voice) < 2:
        return voice[:]

    chord_lookup = _build_chord_lookup(score)
    ts  = measures[start_idx].getContextByClass('TimeSignature') if measures else None
    bpm = float(ts.numerator) if ts else 4.0

    skeleton = _shortest_path_skeleton(voice, chord_lookup,
                                       beats_per_measure=bpm,
                                       max_measure_span=max_measure_span)

    try:
        scale_pcs = set(_pc(p.midi) for p in key_obj.getScale().getPitches('C1', 'C9'))
    except Exception:
        scale_pcs = set(range(12))
    for n in skeleton:
        n['diatonic'] = n['pc'] in scale_pcs
        n['score']    = n['metric_weight'] * n['duration']

    return sorted(skeleton, key=lambda n: (n['measure_rel'], n['beat']))


def _match_skeleton_in_section(skeleton: list, score, sec_start: int, sec_end: int) -> dict:
    """
    Find notes in measures[sec_start:sec_end] that match skeleton pitch classes
    at structurally equivalent metric positions.
    Returns dict[abs_measure_idx (int)] → list of {beat, pc, midi}.
    """
    parts = score.parts
    if not parts:
        return {}
    top_part = parts[0]
    measures  = list(top_part.getElementsByClass('Measure'))
    sec_end   = min(sec_end, len(measures))

    # Build lookup: (measure_rel_mod_period, beat_rounded) → set of expected PCs
    period = (max(n['measure_rel'] for n in skeleton) + 1) if skeleton else 1
    sk_lookup: dict = {}
    for n in skeleton:
        key = (n['measure_rel'] % period, round(n['beat'] * 2) / 2.0)
        sk_lookup.setdefault(key, set()).add(n['pc'])

    highlights: dict = {}
    for rel in range(sec_end - sec_start):
        abs_idx = sec_start + rel
        m       = measures[abs_idx]
        measure_mod = rel % period

        beat_notes: dict = {}
        for el in m.recurse().notesAndRests:
            beat = float(el.offset)
            dur  = float(el.duration.quarterLength)
            if hasattr(el, 'pitch'):
                beat_notes.setdefault(beat, []).append((el.pitch.midi, dur))
            elif hasattr(el, 'pitches'):
                for p in el.pitches:
                    beat_notes.setdefault(beat, []).append((p.midi, dur))

        for beat in sorted(beat_notes.keys()):
            beat_key  = (measure_mod, round(beat * 2) / 2.0)
            target_pcs = sk_lookup.get(beat_key)
            if not target_pcs:
                continue
            top_midi, _ = max(beat_notes[beat], key=lambda x: x[0])
            top_pc = _pc(top_midi)
            if top_pc in target_pcs:
                highlights.setdefault(abs_idx, []).append({
                    'beat': beat,
                    'pc':   top_pc,
                    'midi': top_midi,
                })
    return highlights


@app.get("/api/musicvis/skeleton/{file_name}")
def get_musicvis_skeleton(file_name: str):
    """
    Extract skeleton melody from the Tema section, then locate matching tones
    in each variation section.
    Returns:
      skeleton:   list of {measure_rel, beat, pc, midi, metric_weight, score}
      highlights: dict[str(abs_measure_idx)] → [{beat, pc, midi}]
      tema:       {label, start_idx, end_idx}
      sections:   list of all section dicts
    """
    path = _find_musicxml(file_name)
    if path is None:
        raise HTTPException(404, f"No MusicXML found for {file_name}")
    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    try:
        if path.suffix.lower() == ".mxl":
            xml_bytes = _extract_mxl(path)
            score = music21.converter.parseData(xml_bytes, format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception as e:
        raise HTTPException(500, f"music21 parse error: {e}")

    # Reuse the sections endpoint
    try:
        sections_resp = get_musicvis_sections(file_name)
        sections = sections_resp.get("sections", []) if isinstance(sections_resp, dict) else []
    except Exception:
        sections = []

    if not sections:
        raise HTTPException(404, "No sections found for this file")

    # Locate the Tema section (fallback to first section)
    tema = next(
        (s for s in sections if s['label'].lower() in ('tema', 'theme')),
        sections[0],
    )

    try:
        key_obj = score.analyze('key')
    except Exception:
        key_obj = music21.key.Key('C')

    # Extract skeleton at all three Schenkerian levels from Tema
    # Foreground  (min_weight=0.0, span=2): dense, all beat positions
    # Midground   (min_weight=2.0, span=4): strong beats (♩1 & ♩3 in 4/4)
    # Background  (min_weight=4.0, span=8): downbeats only, coarsest reduction
    skeleton_fg = _extract_skeleton_level(score, tema['start_idx'], tema['end_idx'], key_obj,
                                          min_metric_weight=0.0, max_measure_span=2)
    skeleton_mg = _extract_skeleton_level(score, tema['start_idx'], tema['end_idx'], key_obj,
                                          min_metric_weight=2.0, max_measure_span=4)
    skeleton_bg = _extract_skeleton_level(score, tema['start_idx'], tema['end_idx'], key_obj,
                                          min_metric_weight=4.0, max_measure_span=8)

    def _build_highlights(skeleton: list, sections: list, tema: dict, score) -> dict:
        """Build abs_measure highlights dict for a given skeleton level."""
        highlights: dict = {}
        for n in skeleton:
            abs_idx = str(tema['start_idx'] + n['measure_rel'])
            highlights.setdefault(abs_idx, []).append({
                'beat': n['beat'],
                'pc':   n['pc'],
                'midi': n['midi'],
            })
        for sec in sections:
            if sec['label'] == tema['label']:
                continue
            low = sec['label'].lower()
            if not (low.startswith('var') or low.startswith('theme') or low.startswith('tema')):
                continue
            var_hl = _match_skeleton_in_section(
                skeleton, score, sec['start_idx'], sec['end_idx']
            )
            for abs_idx, notes in var_hl.items():
                highlights.setdefault(str(abs_idx), []).extend(notes)
        return highlights

    highlights    = _build_highlights(skeleton_fg, sections, tema, score)
    highlights_mg = _build_highlights(skeleton_mg, sections, tema, score)
    highlights_bg = _build_highlights(skeleton_bg, sections, tema, score)

    return {
        "matched":               True,
        "key":                   str(key_obj),
        "skeleton":              skeleton_fg,
        "highlights":            highlights,
        "midground_highlights":  highlights_mg,
        "background_highlights": highlights_bg,
        "tema":                  tema,
        "sections":              sections,
    }


# ─── Ornament extraction ──────────────────────────────────────────────────────

@app.get("/api/musicvis/ornaments/{file_name}")
def get_musicvis_ornaments(file_name: str):
    """
    Extract grace notes and explicitly notated ornaments (trill, mordent, turn)
    from MusicXML using music21.

    Returns:
      highlights: dict[str(abs_measure_idx)] → [{beat, pc, midi}]
        - grace notes: exact beat offset of the grace note within the measure
        - ornament expressions: beat offset of the host note
      total: total number of ornamental events found
    """
    path = _find_musicxml(file_name)
    if path is None:
        raise HTTPException(404, f"No MusicXML found for {file_name}")
    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    try:
        if path.suffix.lower() == ".mxl":
            xml_bytes = _extract_mxl(path)
            score = music21.converter.parseData(xml_bytes, format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception as e:
        raise HTTPException(500, f"music21 parse error: {e}")

    # Ornament expression types to detect on regular (non-grace) notes
    ORNAMENT_TYPES = (
        music21.expressions.Trill,
        music21.expressions.Mordent,
        music21.expressions.InvertedMordent,
        music21.expressions.Turn,
        music21.expressions.InvertedTurn,
        music21.expressions.Tremolo,
    )

    highlights: dict = {}
    total = 0

    for part in score.parts:
        measures = list(part.getElementsByClass('Measure'))
        for abs_idx, m in enumerate(measures):
            for el in m.recurse().getElementsByClass(['Note', 'Chord']):
                beat = float(el.offset)
                is_ornament = False

                # 1. Grace note — explicitly marked short ornamental note
                if el.duration.isGrace:
                    is_ornament = True

                # 2. Ornament expression attached to a regular note
                if not is_ornament:
                    for expr in el.expressions:
                        if isinstance(expr, ORNAMENT_TYPES):
                            is_ornament = True
                            break

                if not is_ornament:
                    continue

                key = str(abs_idx)
                if hasattr(el, 'pitch'):
                    highlights.setdefault(key, []).append({
                        'beat': beat,
                        'pc':   el.pitch.midi % 12,
                        'midi': el.pitch.midi,
                    })
                    total += 1
                elif hasattr(el, 'pitches'):
                    for p in el.pitches:
                        highlights.setdefault(key, []).append({
                            'beat': beat,
                            'pc':   p.midi % 12,
                            'midi': p.midi,
                        })
                    total += 1

    return {
        "matched":    True,
        "highlights": highlights,
        "total":      total,
    }


# ─── Chord-tone vs. non-chord-tone extraction ────────────────────────────────

@app.get("/api/musicvis/chordtones/{file_name}")
def get_musicvis_chordtones(file_name: str):
    """
    For every note in the MusicXML, classify it as a chord tone (its pitch class
    is present in the chordified harmony at that moment) or a non-chord tone
    (passing tone, neighbour tone, suspension, etc.).

    Returns:
      highlights: dict[str(abs_measure_idx)] → [{beat, pc, midi, chord_tone: bool}]
      stats: {total, chord_tones, non_chord_tones}
    """
    path = _find_musicxml(file_name)
    if path is None:
        raise HTTPException(404, f"No MusicXML found for {file_name}")
    try:
        import music21
        from music21 import chord as m21chord
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    try:
        if path.suffix.lower() == ".mxl":
            xml_bytes = _extract_mxl(path)
            score = music21.converter.parseData(xml_bytes, format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception as e:
        raise HTTPException(500, f"music21 parse error: {e}")

    # ── Step 1: build absolute-offset → chord PCs lookup via chordify ──
    # chordify() merges all parts into simultaneous Chord objects.
    # We use *absolute* quarter-note offsets (from score start) so that
    # measure-index alignment between parts/chordified output is irrelevant.
    try:
        chordified = score.chordify()
    except Exception as e:
        raise HTTPException(500, f"chordify failed: {e}")

    # Flatten the chordified score to get all Chord elements with absolute offsets
    chord_lookup: list[tuple[float, frozenset]] = []
    try:
        cf_flat = chordified.flatten()
        for el in cf_flat.getElementsByClass('Chord'):
            abs_offset = float(el.offset)
            pcs = frozenset(p.midi % 12 for p in el.pitches)
            chord_lookup.append((abs_offset, pcs))
    except Exception:
        pass
    chord_lookup.sort(key=lambda x: x[0])

    def active_pcs_at(abs_offset: float) -> frozenset:
        """Return pitch-class set of the most recent chord whose offset ≤ abs_offset."""
        pcs: frozenset = frozenset()
        for b, p in chord_lookup:
            if b <= abs_offset + 0.02:
                pcs = p
            else:
                break
        return pcs

    # ── Step 2: classify every note in every part ──────────────────────
    highlights: dict = {}
    total = 0
    n_chord = 0
    n_non   = 0

    for part in score.parts:
        part_measures = list(part.getElementsByClass('Measure'))
        for abs_idx, m in enumerate(part_measures):
            m_offset = float(m.offset)   # absolute offset of this measure in score
            for el in m.recurse().getElementsByClass(['Note', 'Chord']):
                # Skip grace notes (they don't belong to the harmonic grid)
                if el.duration.isGrace:
                    continue
                beat          = float(el.offset)                 # offset within measure
                abs_note_off  = m_offset + beat                  # absolute score offset
                pcs_now       = active_pcs_at(abs_note_off)

                key_str = str(abs_idx)

                def _add(midi_val: int, _beat=beat, _key=key_str, _pcs=pcs_now) -> None:
                    nonlocal total, n_chord, n_non
                    pc = midi_val % 12
                    ct = pc in _pcs
                    highlights.setdefault(_key, []).append({
                        'beat':       _beat,
                        'pc':         pc,
                        'midi':       midi_val,
                        'chord_tone': ct,
                    })
                    total += 1
                    if ct:
                        n_chord += 1
                    else:
                        n_non += 1

                if hasattr(el, 'pitch'):
                    _add(el.pitch.midi)
                elif hasattr(el, 'pitches'):
                    for p in el.pitches:
                        _add(p.midi)

    return {
        "matched":    True,
        "highlights": highlights,
        "stats": {
            "total":          total,
            "chord_tones":    n_chord,
            "non_chord_tones": n_non,
            "nct_ratio":      round(n_non / total, 3) if total else 0,
        },
    }


@app.get("/api/musicvis/harmonics/{file_name}")
def get_musicvis_harmonics(file_name: str):
    """
    Parse MusicXML with music21 and return per-measure harmonic analysis.
    Returns:
      measures: list of { index, chroma_cof: [12], dominant_pc: int, note_count: int }
    """
    path = _find_musicxml(file_name)
    if path is None:
        raise HTTPException(404, f"No MusicXML found for {file_name} in MusicXML/")

    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    try:
        score = music21.converter.parse(str(path))
    except Exception as e:
        raise HTTPException(500, f"music21 parse error: {e}")

    # Flatten to a single part (use highest part = melody)
    parts = score.parts
    if not parts:
        raise HTTPException(500, "No parts found in score")

    # Collect notes from ALL parts into per-measure buckets
    measures_data = []
    # Use score.recurse() to get all measures across all parts
    all_measures_by_num: dict[int, list] = {}

    for part in parts:
        for m in part.getElementsByClass("Measure"):
            mnum = m.measureNumber
            if mnum not in all_measures_by_num:
                all_measures_by_num[mnum] = []
            for el in m.recurse().notesAndRests:
                if hasattr(el, "pitch"):  # Note
                    all_measures_by_num[mnum].append(el.pitch.midi % 12)
                elif hasattr(el, "pitches"):  # Chord
                    for p in el.pitches:
                        all_measures_by_num[mnum].append(p.midi % 12)

    for mnum in sorted(all_measures_by_num.keys()):
        pcs = all_measures_by_num[mnum]
        counts = [0.0] * 12
        for pc in pcs:
            counts[pc] += 1.0
        total = sum(counts) or 1.0
        norm = [counts[pc] / total for pc in range(12)]
        # Reorder to COF
        chroma_cof = [norm[_COF_ORDER[i]] for i in range(12)]
        dominant_pc = max(range(12), key=lambda i: norm[i]) if pcs else 0
        measures_data.append({
            "index":       mnum,
            "chroma_cof":  [round(v, 4) for v in chroma_cof],
            "dominant_pc": dominant_pc,
            "note_count":  len(pcs),
        })

    return {
        "matched":   True,
        "file_name": file_name,
        "measures":  measures_data,
        "cof_names": _COF_NAMES,
    }


@app.get("/api/midi/notes/{file_name}")
def get_midi_notes(file_name: str, n_variations: int | None = None):
    """
    Return raw MIDI note list + segment boundaries for piano-roll rendering.
    Each note: { pitch, beat, dur_beats, velocity, seg }.
    Segment boundaries derived via the same annotation-guided strategy as
    /api/midi/{file_name}.
    """
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {"matched": False, "message": f"No MIDI found for '{file_name}'"}

    if mido is None:
        raise HTTPException(500, "mido not installed")

    mid    = mido.MidiFile(str(midi_path))
    tpb    = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    # ── Tempo map ──────────────────────────────────────────────────────
    tempo_map: list[tuple[int, int]] = [(0, 500_000)]
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "set_tempo":
            tempo_map.append((abs_t, msg.tempo))

    def tick2beat(t: int) -> float:
        return t / tpb

    # ── Parse notes ────────────────────────────────────────────────────
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

    # ── Segment boundaries ──────────────────────────────────────────────
    var_labels: list[str] = []
    var_starts: list[int] = []

    # Priority 0: MusicXML section markers — most accurate, uses actual score labels
    mxml_secs = _get_musicxml_sections(file_name)
    if mxml_secs:
        var_labels = [s[0] for s in mxml_secs]
        var_starts = [s[1] for s in mxml_secs]

    # Priority 1: caller-supplied n_variations (used when MusicXML unavailable)
    if not var_labels and n_variations is not None and n_variations >= 1:
        n_segs = n_variations + 1
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_variations + 1)]

    k_num = _extract_k_number(midi_path.name)
    if not var_labels and k_num and ANNOTATION.exists():
        try:
            ann = pd.read_excel(ANNOTATION)
            pat = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
            rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
            if not rows.empty:
                row = rows.iloc[0]
                raw_lbl = str(row.get("label", "")).strip().strip("[]").replace("'","").replace('"',"")
                lbl_list = [s.strip() for s in raw_lbl.split(",") if s.strip()]
                def _nl(l: str) -> str:
                    if l in ("T","Theme"): return "Theme"
                    if l in ("C","Coda"):  return "Coda"
                    m2 = re.match(r"V(\d+)", l, re.IGNORECASE)
                    return f"Var.{int(m2.group(1)):02d}" if m2 else l
                lbl_list = [_nl(l) for l in lbl_list]
                if len(lbl_list) >= 2:
                    step = total_bars / len(lbl_list)
                    var_starts = [round(i * step) for i in range(len(lbl_list))]
                    var_labels = lbl_list
        except Exception:
            pass

    if not var_labels:
        theme_bars = 16; var_bars = 16
        var_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, 13)]
        var_starts = [0] + [theme_bars + i * var_bars for i in range(12)]

    var_ends = var_starts[1:] + [total_bars]

    # Build segment list with beat ranges
    segments = []
    for i, (label, bar_s, bar_e) in enumerate(zip(var_labels, var_starts, var_ends)):
        segments.append({
            "idx":        i,
            "label":      label,
            "beat_start": round(bar_s * beats_per_bar, 2),
            "beat_end":   round(min(bar_e * beats_per_bar, total_beats), 2),
        })

    # Tag each note with segment index
    seg_beat_starts = [s["beat_start"] for s in segments]
    for n in raw_notes:
        seg_idx = 0
        for k, bs in enumerate(seg_beat_starts):
            if n["beat"] >= bs:
                seg_idx = k
        n["seg"] = seg_idx

    # Average tempo in BPM (weighted by note count in each tempo region)
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


@app.get("/api/midi/{file_name}")
def get_midi_analysis(file_name: str, n_variations: int | None = None):
    """
    Fuzzy-match file_name → TV_MIDI/ via K-number, parse with mido,
    return per-variation structural analysis.
    Optional query param n_variations: if provided, overrides MIDI segmentation
    to produce exactly n_variations+1 segments (Theme + N vars), matching the
    audio-extracted segment count from the annotation spreadsheet.
    """
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {
            "matched":   False,
            "file_name": file_name,
            "message":   f"No matching MIDI found for '{file_name}' in TV_MIDI/",
        }
    result = _parse_midi_analysis(midi_path, n_variations=n_variations)
    result["file_name"] = file_name
    return result



# ── /api/symbolic/{file_name} ─────────────────────────────────────────

# Feature metadata: (key, label_zh, label_en, category, chart_type)
# chart_type: 'continuous' | 'ratio' | 'signed' | 'count' | 'entropy'
# Krumhansl-Kessler pitch-class profiles for tonal clarity
_KK_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]
_KK_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]

# Feature metadata: (key, label_zh, label_en, category, chart_type)
SYMBOLIC_FEATURE_DEFS = [
    # ── Pitch (12) ────────────────────────────────────────────────────
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
    # ── Melodic (10) ──────────────────────────────────────────────────
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
    # ── Rhythmic (8) ──────────────────────────────────────────────────
    ("note_density",              "音符密度",     "Note Density",              "R", "continuous"),
    ("mean_note_duration",        "平均时值",     "Mean Note Duration",        "R", "continuous"),
    ("duration_variability",      "时值变化率",   "Duration Variability",      "R", "continuous"),
    ("short_note_ratio",          "短音符比率",   "Short Note Ratio",          "R", "ratio"),
    ("long_note_ratio",           "长音符比率",   "Long Note Ratio",           "R", "ratio"),
    ("rest_ratio",                "休止比率",     "Rest Ratio",                "R", "ratio"),
    ("rhythmic_value_variety",    "时值种类数",   "Rhythmic Value Variety",    "R", "count"),
    ("duration_entropy",          "时值熵",       "Duration Entropy",          "R", "entropy"),
    # ── Texture (3) ───────────────────────────────────────────────────
    ("max_simultaneous_notes",    "最大和弦厚度", "Max Simultaneous Notes",    "T", "count"),
    ("mean_simultaneous_notes",   "平均和弦厚度", "Mean Simultaneous Notes",   "T", "continuous"),
    ("chord_onset_ratio",         "和弦起始比率", "Chord Onset Ratio",         "T", "ratio"),
]


def _compute_symbolic_features(notes_sec: list[dict], seg_dur: float) -> dict:
    """
    Compute 26 scalar symbolic features for one segment.

    Each note dict: { "pitch": int, "start_sec": float, "dur_sec": float }
    seg_dur: total duration of the segment in seconds.

    Feature groups
    ──────────────
    Pitch (8):    pitch_range, mean_pitch, pitch_std, pitch_variety,
                  most_common_pc_prevalence, pitch_class_entropy,
                  bass_register_ratio, high_register_ratio
    Melodic (10): mean_melodic_interval, repeated_notes_ratio, stepwise_ratio,
                  chromatic_ratio, leap_ratio, large_leap_ratio,
                  direction_of_motion, arpeggiation_ratio,
                  melodic_interval_variety, interval_entropy
    Rhythmic (8): note_density, mean_note_duration, duration_variability,
                  short_note_ratio, long_note_ratio, rest_ratio,
                  rhythmic_value_variety, duration_entropy
    """
    import math as _math
    from collections import Counter as _Counter

    result: dict = {k: 0.0 for k, *_ in SYMBOLIC_FEATURE_DEFS}

    if not notes_sec:
        return result

    pitches   = [n["pitch"]     for n in notes_sec]
    pcs       = [p % 12         for p in pitches]
    durations = [max(n["dur_sec"], 1e-6) for n in notes_sec]
    starts    = [n["start_sec"] for n in notes_sec]
    n         = len(notes_sec)

    # ── Pitch ─────────────────────────────────────────────────────────
    mean_p = sum(pitches) / n
    result["pitch_range"] = float(max(pitches) - min(pitches))
    result["mean_pitch"]  = mean_p
    result["pitch_std"]   = _math.sqrt(sum((p - mean_p)**2 for p in pitches) / n)
    result["pitch_variety"] = float(len(set(pcs)))

    pc_counts = _Counter(pcs)
    result["most_common_pc_prevalence"] = pc_counts.most_common(1)[0][1] / n

    pc_ent = 0.0
    for cnt in pc_counts.values():
        p_ = cnt / n
        if p_ > 0:
            pc_ent -= p_ * _math.log2(p_)
    result["pitch_class_entropy"] = pc_ent / _math.log2(12) if pc_ent > 0 else 0.0

    result["bass_register_ratio"] = sum(1 for p in pitches if p < 48) / n   # below C3
    result["high_register_ratio"] = sum(1 for p in pitches if p > 72) / n   # above C5

    # most common pitch class (0–11)
    result["most_common_pc"] = float(pc_counts.most_common(1)[0][0])

    # chromatic density: distinct PCs / 12
    result["chromatic_density"] = len(set(pcs)) / 12.0

    # tonal clarity: max Pearson r vs all 24 major/minor key templates
    pc_hist = [0] * 12
    for pc_ in pcs:
        pc_hist[pc_] += 1
    def _pearson(a: list, b: list) -> float:
        n_ = len(a); ma = sum(a)/n_; mb = sum(b)/n_
        num = sum((x-ma)*(y-mb) for x,y in zip(a,b))
        sa = _math.sqrt(sum((x-ma)**2 for x in a))
        sb = _math.sqrt(sum((y-mb)**2 for y in b))
        return num/(sa*sb) if sa*sb > 1e-9 else 0.0
    best = 0.0
    for root in range(12):
        maj = [_KK_MAJOR[(i-root) % 12] for i in range(12)]
        mn  = [_KK_MINOR[(i-root) % 12] for i in range(12)]
        best = max(best, _pearson(pc_hist, maj), _pearson(pc_hist, mn))
    result["tonal_clarity"] = max(0.0, best)

    # ── Melodic ───────────────────────────────────────────────────────
    if n >= 2:
        sn = sorted(notes_sec, key=lambda x: x["start_sec"])
        sp = [x["pitch"] for x in sn]
        raw_iv  = [sp[i+1] - sp[i] for i in range(len(sp)-1)]
        abs_iv  = [abs(iv) for iv in raw_iv]
        n_iv    = len(abs_iv)

        result["mean_melodic_interval"]    = sum(abs_iv) / n_iv
        result["repeated_notes_ratio"]     = sum(1 for iv in abs_iv if iv == 0) / n_iv
        result["stepwise_ratio"]           = sum(1 for iv in abs_iv if iv <= 2) / n_iv
        result["chromatic_ratio"]          = sum(1 for iv in abs_iv if iv == 1) / n_iv
        result["leap_ratio"]               = sum(1 for iv in abs_iv if iv > 4) / n_iv
        result["large_leap_ratio"]         = sum(1 for iv in abs_iv if iv > 7) / n_iv
        result["arpeggiation_ratio"]       = sum(1 for iv in abs_iv if iv in (3,4,7,8)) / n_iv

        asc  = sum(1 for iv in raw_iv if iv > 0)
        desc = sum(1 for iv in raw_iv if iv < 0)
        denom = asc + desc
        result["direction_of_motion"] = (asc - desc) / denom if denom else 0.0

        result["melodic_interval_variety"] = float(len(set(abs_iv)))

        # interval class variety: how many of IC 0-6 appear (min(iv%12, 12-iv%12))
        ics = set(min(iv % 12, 12 - iv % 12) for iv in abs_iv)
        result["interval_class_variety"] = float(len(ics))

        iv_counts = _Counter(abs_iv)
        iv_ent = 0.0
        for cnt in iv_counts.values():
            p_ = cnt / n_iv
            if p_ > 0:
                iv_ent -= p_ * _math.log2(p_)
        max_iv_ent = _math.log2(len(iv_counts)) if len(iv_counts) > 1 else 1.0
        result["interval_entropy"] = iv_ent / max_iv_ent if max_iv_ent > 0 else 0.0

    # ── Rhythmic ──────────────────────────────────────────────────────
    mean_d = sum(durations) / n
    result["note_density"]       = n / max(seg_dur, 1e-6)
    result["mean_note_duration"] = mean_d

    if n >= 2:
        std_d = _math.sqrt(sum((d - mean_d)**2 for d in durations) / n)
        result["duration_variability"] = std_d / mean_d if mean_d > 0 else 0.0

        sorted_d = sorted(durations)
        median_d = sorted_d[n // 2]
        result["short_note_ratio"] = sum(1 for d in durations if d < median_d * 0.5) / n
        result["long_note_ratio"]  = sum(1 for d in durations if d > median_d * 2.0) / n

        # Quantize to 32nd-note bins (0.03125 s at 60 BPM) for variety/entropy
        BIN = 0.04
        bins = [round(d / BIN) for d in durations]
        bin_counts = _Counter(bins)
        result["rhythmic_value_variety"] = float(len(bin_counts))

        dur_ent = 0.0
        for cnt in bin_counts.values():
            p_ = cnt / n
            if p_ > 0:
                dur_ent -= p_ * _math.log2(p_)
        max_dur_ent = _math.log2(len(bin_counts)) if len(bin_counts) > 1 else 1.0
        result["duration_entropy"] = dur_ent / max_dur_ent if max_dur_ent > 0 else 0.0

    # ── Texture ───────────────────────────────────────────────────────
    # Build note-on / note-off event stream and scan for polyphony
    events: list[tuple[float, int]] = []
    for note in notes_sec:
        events.append((note["start_sec"], 1))
        events.append((note["start_sec"] + note["dur_sec"], -1))
    # At equal times: process note-offs before note-ons (conservative polyphony)
    events.sort(key=lambda x: (x[0], x[1]))

    # rest_ratio: fraction of segment duration where NO note is sounding.
    # Computed from the event timeline so polyphony is handled correctly —
    # the naive sum(durations) approach double-counts simultaneous notes
    # and always yields 0 for piano/ensemble MIDI.
    if events and seg_dur > 0:
        _sound_time = 0.0
        _curr = 0
        _prev_t: float | None = None
        for _t, _d in events:
            if _prev_t is not None and _t > _prev_t and _curr > 0:
                _sound_time += _t - _prev_t
            _curr += _d
            _prev_t = _t
        result["rest_ratio"] = max(0.0, 1.0 - _sound_time / seg_dur)
    else:
        result["rest_ratio"] = 0.0

    curr = 0; max_sim = 0; total_w = 0.0; prev_t: float | None = None
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

    # chord_onset_ratio: fraction of onsets that share a start within 50 ms
    CHORD_TOL = 0.05
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


def _compute_distributions(notes_sec: list[dict]) -> dict:
    """
    Compute three normalized histograms for one segment:
      pitch_class      – 12 bins (PC 0–11)
      melodic_interval – 13 bins (|semitone interval| 0–11, last bin = ≥12)
      note_duration    – 12 bins (0–0.1 s, 0.1–0.2 s, …, ≥1.1 s)
    All bins are normalized so they sum to 1.0 (frequency ratios).
    Returns lists of floats, ready for JSON serialisation.
    """
    n = len(notes_sec)

    # ── Pitch-class histogram (12 bins) ─────────────────────────────────
    pc = [0.0] * 12
    for note in notes_sec:
        pc[int(note["pitch"]) % 12] += 1.0
    total_pc = sum(pc) or 1.0
    pc = [v / total_pc for v in pc]

    # ── Melodic-interval histogram (13 bins, by note onset order) ───────
    mi = [0.0] * 13
    if n >= 2:
        sorted_notes = sorted(notes_sec, key=lambda x: x["start_sec"])
        for i in range(1, len(sorted_notes)):
            iv = abs(int(sorted_notes[i]["pitch"]) - int(sorted_notes[i - 1]["pitch"]))
            mi[min(iv, 12)] += 1.0
        total_mi = sum(mi) or 1.0
        mi = [v / total_mi for v in mi]

    # ── Note-duration histogram (12 bins × 0.1 s, last = ≥1.1 s) ───────
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


# ── MusicXML-based symbolic extraction ────────────────────────────────────────

_MXL_SKIP = ("m.s.", "m.d.", "destra", "sinistra", "ritard", "fine", "segue",
             "rit.", "poco", "sempre", "cresc", "decresc", "dim.", "sfz", "fz",
             "dolce", "legato", "staccato", "andantino", "andante",
             "allegro", "adagio", "moderato", "presto", "vivace", "largo", "lento")
_MXL_ROMAN = {
    "i":1,"ii":2,"iii":3,"iv":4,"v":5,"vi":6,"vii":7,"viii":8,"ix":9,"x":10,
    "xi":11,"xii":12,"xiii":13,"xiv":14,"xv":15,"xvi":16,"xvii":17,"xviii":18,
    "xix":19,"xx":20,"xxi":21,"xxii":22,"xxiii":23,"xxiv":24,"xxv":25,
    "xxvi":26,"xxvii":27,"xxviii":28,"xxix":29,"xxx":30,
}


def _mxl_label_key(label: str) -> int:
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


def _mxl_key_to_label(key: int, orig: str = "") -> str:
    if key == 0:   return "T"
    if key == 999: return "C"
    if key == 998: return orig.strip() or "?"   # unrecognised label
    if key >= 1:   return f"V{key}"             # V1 … V997, no upper limit
    return orig.strip() or "?"


def _find_mxl_for_stem(piece_stem: str) -> "Path | None":
    for ext in (".mxl", ".xml", ".musicxml"):
        p = MUSICXML_DIR / f"{piece_stem}{ext}"
        if p.exists():
            return p
    return None


def _read_mxl_xml_bytes(path: "Path") -> bytes:
    import zipfile as _zf
    if path.suffix.lower() == ".mxl":
        with _zf.ZipFile(path, "r") as z:
            xml_name = next(
                (n for n in z.namelist()
                 if n.endswith(".xml") and "META" not in n.upper()), None)
            if xml_name is None:
                raise ValueError("No XML inside .mxl")
            return z.read(xml_name)
    return path.read_bytes()


def _parse_mxl_symbolic(piece_stem: str) -> "list[dict] | None":
    """
    Parse MusicXML and return per-section note lists ready for
    _compute_symbolic_features().

    Returns list of:
        { label: str, notes_sec: list[{pitch,start_sec,dur_sec}],
          seg_dur_sec: float }
    or None if MusicXML unavailable / no rehearsal marks found.
    """
    path = _find_mxl_for_stem(piece_stem)
    if path is None:
        return None

    try:
        import music21
        xml_bytes = _read_mxl_xml_bytes(path)
        score = music21.converter.parseData(xml_bytes, format="musicxml")
    except Exception as e:
        print(f"  [symbolic] MusicXML parse error ({piece_stem}): {e}")
        return None

    if not score.parts:
        return None

    # ── Tempo: first MetronomeMark in score, default 120 ──────────────
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

    # ── Collect all notes from all parts ──────────────────────────────
    all_notes: list[dict] = []
    for part in score.parts:
        for el in part.flatten().notes:
            if hasattr(el, "pitch"):  # single Note
                all_notes.append({
                    "pitch":    el.pitch.midi,
                    "start_qn": float(el.offset),
                    "dur_qn":   float(el.duration.quarterLength) or 0.125,
                })
            else:  # Chord
                for p in el.pitches:
                    all_notes.append({
                        "pitch":    p.midi,
                        "start_qn": float(el.offset),
                        "dur_qn":   float(el.duration.quarterLength) or 0.125,
                    })

    if not all_notes:
        return None

    # ── Detect section boundaries from Rehearsal/TextExpression ───────
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
        return None   # can't segment — fallback to MIDI

    total_qn = max(n["start_qn"] for n in all_notes) + 0.5

    # ── Build section data ─────────────────────────────────────────────
    result: list[dict] = []
    for i, (off, lbl) in enumerate(raw_sections):
        key      = _mxl_label_key(lbl)
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
            "label":       _mxl_key_to_label(key, lbl),
            "notes_sec":   notes_sec,
            "seg_dur_sec": seg_dur_sec,
        })

    return result


@app.get("/api/symbolic/{file_name}")
def get_symbolic_features(file_name: str):
    """
    Extract symbolic music features per segment.

    Priority:
      1. MusicXML  — segment by Rehearsal Mark, notes from score (accurate)
      2. MIDI      — segment by audio annotation timestamps (legacy fallback)

    Returns:
        { matched, source, segments: [{label, n_notes, features, distributions}],
          feature_defs: [{key, label_zh, label_en, cat, chart_type}] }
    """
    feature_defs_out = [
        {"key": k, "label_zh": zh, "label_en": en, "cat": cat, "chart_type": ct}
        for k, zh, en, cat, ct in SYMBOLIC_FEATURE_DEFS
    ]

    # ── 1. Try MusicXML ────────────────────────────────────────────────
    piece_stem  = re.sub(r"_\d+$", "", file_name)
    mxl_sections = _parse_mxl_symbolic(piece_stem)

    if mxl_sections is not None:
        result_segments = []
        for sec in mxl_sections:
            if sec["label"] == "C":          # skip Coda
                continue
            notes = sec["notes_sec"]
            feats = _compute_symbolic_features(notes, sec["seg_dur_sec"])
            dists = _compute_distributions(notes)
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
                "midi_name":    f"{piece_stem}.mxl",   # kept for UI compat
                "segments":     result_segments,
                "feature_defs": feature_defs_out,
            }

    # ── 2. Graceful no-data response for temp uploads ──────────────────
    # Temp pieces have no MIDI. If the MXL had no rehearsal marks (mxl_sections
    # was None) we cannot segment it symbolically. Return an empty-but-valid
    # response so the frontend can show a "no data source" notice instead of
    # crashing with a 404.
    if piece_stem.startswith("temp_"):
        return {
            "matched":      False,
            "file_name":    file_name,
            "source":       "none",
            "segments":     [],
            "feature_defs": feature_defs_out,
            "message":      (
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

    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        raise HTTPException(
            404,
            f"No MIDI file found for '{file_name}'. "
            "Check that TV_MIDI/ contains a matching .mid file."
        )

    if mido is None:
        raise HTTPException(500, "mido not installed — run: pip install mido")

    # ── Parse MIDI → note list with seconds ───────────────────────────
    mid    = mido.MidiFile(str(midi_path))
    tpb    = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    # Build tempo map: list of (abs_tick, tempo_us)
    tempo_map: list[tuple[int, int]] = [(0, 500_000)]
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "set_tempo":
            tempo_map.append((abs_t, msg.tempo))

    def tick2sec(tick: int) -> float:
        sec = 0.0
        for i, (t0, tmpo) in enumerate(tempo_map):
            t1 = tempo_map[i + 1][0] if i + 1 < len(tempo_map) else tick
            seg = min(t1, tick)
            sec += (seg - t0) * tmpo / 1_000_000 / tpb
            if seg >= tick:
                break
        return sec

    # Collect all note-on/off pairs with times in seconds
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

    # ── Override segments with score-based boundaries (version-invariant) ─
    # If a shared MusicXML score exists, derive section timestamps from
    # measure offsets in the score rather than from per-version audio JSON.
    # This ensures all performance versions of the same piece return identical
    # feature values, since they share one canonical score structure.
    mxl_path = _find_musicxml(file_name)
    if mxl_path is not None:
        try:
            import music21 as _m21
            if mxl_path.suffix.lower() == ".mxl":
                _xml_bytes = _extract_mxl(mxl_path)
                _score = _m21.converter.parseData(_xml_bytes, format="musicxml")
            else:
                _score = _m21.converter.parse(str(mxl_path))

            _sections = _get_musicxml_sections(file_name)  # [(label, measure_idx), ...]

            if _sections and _score.parts:
                _part     = _score.parts[0]
                _measures = list(_part.getElementsByClass("Measure"))

                def _measure_qn(idx: int) -> float:
                    """Quarter-note offset of measure at index idx."""
                    if idx < len(_measures):
                        return float(_measures[idx].offset)
                    last = _measures[-1]
                    return float(last.offset) + float(last.duration.quarterLength)

                # Total duration in quarter notes (end of last measure)
                _total_qn = _measure_qn(len(_measures))

                def _qn_to_sec(qn: float) -> float:
                    return tick2sec(int(round(qn * tpb)))

                _score_segs: list[dict] = []
                for _i, (_lbl, _midx) in enumerate(_sections):
                    if _lbl == "Coda":
                        continue
                    _start_qn = _measure_qn(_midx)
                    # end = start of next non-Coda section
                    _end_qn: float | None = None
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
                    segments_meta = _score_segs   # replace audio-derived timestamps
        except Exception:
            pass  # fall back silently to audio-derived segments_meta

    # ── Assign notes to segments based on start_sec ────────────────────
    result_segments = []
    for sm in segments_meta:
        seg_start = sm["start_sec"]
        seg_end   = sm["end_sec"]
        seg_dur   = max(seg_end - seg_start, 1e-6)

        seg_notes = [
            n for n in all_notes
            if seg_start <= n["start_sec"] < seg_end
        ]

        feats = _compute_symbolic_features(seg_notes, seg_dur)
        dists = _compute_distributions(seg_notes)
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


# ── /api/upload/process ────────────────────────────────────────────────────
#
# Accept optional MusicXML + optional audio + boundary string + piece name.
# Parse boundaries (MM.SS), auto-generate labels (T, V1, V2, …).
# Extract features from whichever files were provided.
# Save to a temp JSON file (FEATURE_DIR / temp_{uuid}.json).
# Return { temp_id, music_name, available_views }.
#
# Available views by input combination:
#   MusicXML only  → symbolic_heatmap, pitch_contour_score, harmonic_function
#   Audio only     → rhythm_bubble, mental_landscape, overview
#   Both           → all of the above
#
# The feature JSON written here is a subset of the standard feature JSON so
# that existing view components can consume it unchanged.

COF_ORDER_U = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
COF_NAMES_U = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"]
CHROMA_NAMES_U = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _mmss_to_sec(value: float) -> float:
    """Convert MM.SS float (1.57 = 1 min 57 sec) to total seconds."""
    minutes = int(value)
    seconds = round((value - minutes) * 100, 1)
    return float(minutes * 60 + seconds)


def _parse_boundaries(raw: str) -> list[float]:
    """Parse comma-separated MM.SS boundary string into sorted seconds list."""
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    secs = []
    for p in parts:
        try:
            secs.append(_mmss_to_sec(float(p)))
        except ValueError:
            pass
    return sorted(secs)


def _auto_labels(n_segments: int) -> list[str]:
    """Generate [T, V1, V2, …] for n_segments segments."""
    labels = ["T"]
    for i in range(1, n_segments):
        labels.append(f"V{i}")
    return labels


def _safe_float(v) -> float:
    try:
        x = float(v)
        return 0.0 if (math.isnan(x) or math.isinf(x)) else x
    except Exception:
        return 0.0


def _safe_list(arr) -> list:
    if arr is None:
        return []
    return [_safe_float(x) for x in arr]


def _chroma_to_cof(chroma: list) -> list:
    return [chroma[i] for i in COF_ORDER_U]


def _extract_audio_segment(y, sr, label: str, compressed_frames: int = 64) -> dict:
    """Inline audio feature extraction for uploaded segments (mirrors extract_features.py)."""
    if librosa is None or np is None:
        raise RuntimeError("librosa / numpy not installed")

    feats: dict = {}

    # 1. Chroma
    chroma_cqt = librosa.feature.chroma_cqt(y=y, sr=sr, bins_per_octave=36)
    chroma_mean = np.mean(chroma_cqt, axis=1)
    chroma_norm = chroma_mean / (chroma_mean.sum() + 1e-8)
    feats["chroma_chromatic"] = _safe_list(chroma_norm)
    feats["chroma_cof"]       = _safe_list(_chroma_to_cof(chroma_norm.tolist()))
    # dominant_pitch must be {name, cof_index} object (not a plain int)
    dp_pc = int(np.argmax(chroma_norm))   # chromatic pitch class 0-11
    feats["dominant_pitch"] = {
        "name":      CHROMA_NAMES_U[dp_pc],
        "cof_index": COF_ORDER_U.index(dp_pc),
    }

    # 2. MFCC
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    feats["mfcc_mean"] = _safe_list(np.mean(mfcc, axis=1))
    feats["mfcc_std"]  = _safe_list(np.std(mfcc, axis=1))

    # 3. RMS / dynamics
    rms = librosa.feature.rms(y=y)[0]
    rms_mean = float(np.mean(rms))
    rms_max  = float(np.max(rms))
    rms_min_nz = float(np.min(rms[rms > 1e-6])) if np.any(rms > 1e-6) else 1e-6
    feats["rms_mean"]         = _safe_float(rms_mean)
    feats["rms_std"]          = _safe_float(np.std(rms))
    feats["rms_max"]          = _safe_float(rms_max)
    feats["dynamic_range_db"] = _safe_float(
        20 * math.log10(rms_max / rms_min_nz) if rms_max > 1e-6 else 0.0
    )

    # 4. Spectral centroid
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    feats["spectral_centroid_mean"] = _safe_float(np.mean(centroid))
    feats["spectral_centroid_std"]  = _safe_float(np.std(centroid))

    # 5. Onset / rhythm
    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    duration_sec = len(y) / sr
    feats["onset_density"] = _safe_float(
        len(onset_frames) / duration_sec if duration_sec > 0 else 0
    )
    if len(onset_frames) >= 3:
        intervals = np.diff(onset_frames)
        mean_ioi = float(np.mean(intervals))
        std_ioi  = float(np.std(intervals))
        cov = std_ioi / mean_ioi if mean_ioi > 0 else 1.0
        feats["rhythm_regularity"] = _safe_float(1.0 / (1.0 + cov))
    else:
        feats["rhythm_regularity"] = 0.5

    # Tempo
    try:
        tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
        feats["tempo"] = _safe_float(float(np.squeeze(tempo_arr)))
    except Exception:
        feats["tempo"] = 0.0

    # 6. Tonnetz
    try:
        harm = librosa.effects.harmonic(y=y)
        tnet = librosa.feature.tonnetz(y=harm, sr=sr)
        feats["tonnetz_mean"] = _safe_list(np.mean(tnet, axis=1))
    except Exception:
        feats["tonnetz_mean"] = [0.0] * 6

    # 7. Chord recognition (simple template matching)
    try:
        chroma_stft = librosa.feature.chroma_stft(y=y, sr=sr)
        chroma_avg  = np.mean(chroma_stft, axis=1)
        import numpy as _np
        templates = _np.zeros((24, 12))
        for r in range(12):
            templates[r,      [r, (r+4)%12, (r+7)%12]] = 1.0
            templates[r + 12, [r, (r+3)%12, (r+7)%12]] = 1.0
        norms = _np.linalg.norm(templates, axis=1)
        sims  = templates @ chroma_avg / (norms * (_np.linalg.norm(chroma_avg) + 1e-8) + 1e-8)
        best  = int(_np.argmax(sims))
        root  = best % 12
        mode  = "major" if best < 12 else "minor"
        feats["chord_recognition"] = {"root": root, "mode": mode,
                                       "root_name": CHROMA_NAMES_U[root]}
    except Exception:
        feats["chord_recognition"] = {"root": 0, "mode": "major", "root_name": "C"}

    # 8. Missing scalar features (required by OverviewPage PCA)
    try:
        feats["zcr_mean"]              = _safe_float(float(np.mean(librosa.feature.zero_crossing_rate(y=y)[0])))
        feats["spectral_flatness_mean"]= _safe_float(float(np.mean(librosa.feature.spectral_flatness(y=y)[0])))
        sc = librosa.feature.spectral_contrast(y=y, sr=sr)
        feats["spectral_contrast_mean"]= _safe_list(np.mean(sc, axis=1))
    except Exception:
        feats["zcr_mean"]               = 0.0
        feats["spectral_flatness_mean"] = 0.0
        feats["spectral_contrast_mean"] = [0.0] * 7

    # 9. Compressed time-series (64 frames)
    # Full structure: n_frames, rms[64], spectral_centroid[64], chroma_cof[12][64], onset_count[64]
    n = compressed_frames

    # Downsample frame-level arrays to n frames via linear interpolation indices
    def _downsample(arr_1d, target):
        arr = np.array(arr_1d, dtype=float)
        if len(arr) == 0:
            return [0.0] * target
        indices = np.linspace(0, len(arr) - 1, target).astype(int)
        return _safe_list(arr[indices])

    rms_comp      = _downsample(librosa.feature.rms(y=y)[0], n)
    centroid_comp = _downsample(centroid, n)

    # chroma_cof per frame: shape (12, n_frames_orig) → downsample to (12, n)
    chroma_cof_frames = []
    for pc_idx in COF_ORDER_U:          # iterate in COF order
        row = chroma_cqt[pc_idx, :]     # raw CQT chroma for this pitch class
        chroma_cof_frames.append(_downsample(row, n))

    # onset count per frame
    onset_comp = [0] * n
    if duration_sec > 0:
        for t in onset_frames:
            idx = int(t / duration_sec * n)
            if 0 <= idx < n:
                onset_comp[idx] += 1

    feats["compressed"] = {
        "n_frames":          n,
        "rms":               rms_comp,
        "spectral_centroid": centroid_comp,
        "chroma_cof":        chroma_cof_frames,   # [12][n]
        "onset_count":       onset_comp,
    }

    # 10. pYIN pitch contour — directly import from add_pitch_contour.py
    #     to guarantee identical output to the dataset pipeline.
    try:
        import importlib.util as _ilu
        _apc_path = Path(__file__).parent / "add_pitch_contour.py"
        _apc_spec = _ilu.spec_from_file_location("add_pitch_contour", _apc_path)
        _apc      = _ilu.module_from_spec(_apc_spec)
        _apc_spec.loader.exec_module(_apc)

        chroma_chromatic = feats.get("chroma_chromatic", [0.0] * 12)
        pc = _apc.extract_pitch_contour(y, sr, chroma_chromatic, n)
        feats["pitch_contour"] = pc
    except Exception as _e:
        print(f"  [upload] pitch_contour failed: {_e}")
        feats["pitch_contour"] = {"beat_midi": [], "midi_relative": [], "n_frames": n, "midi": []}

    return feats


def _extract_mxl_pitch_contour(mxl_sections: list) -> list[dict]:
    """
    Convert MusicXML note data (from _parse_mxl_symbolic) into pitch_contour
    dicts per section, matching the format expected by OverviewPage / pYIN.
    Returns a list of { beat_midi: [...], midi_relative: [...] } per section.
    """
    result = []
    for sec in mxl_sections:
        if sec["label"] == "C":
            continue
        notes = sec["notes_sec"]
        if not notes:
            result.append({"beat_midi": [], "midi_relative": []})
            continue
        pitches = [n["pitch"] for n in sorted(notes, key=lambda x: x["start_sec"])]
        # Downsample to 64 values
        indices = [int(i * (len(pitches) - 1) / 63) for i in range(min(64, len(pitches)))]
        sampled = [pitches[i] for i in indices]
        mean_p  = sum(sampled) / len(sampled)
        rel     = [p - mean_p for p in sampled]
        result.append({"beat_midi": sampled, "midi_relative": rel})
    return result


@app.post("/api/upload/process")
async def upload_and_process(
    piece_name:  str                  = Form(...),
    boundaries:  str                  = Form(""),   # optional for MXL-only uploads
    musicxml:    UploadFile | None    = File(None),
    audio:       UploadFile | None    = File(None),
    pdf:         UploadFile | None    = File(None),
):
    """
    Accept uploaded files, extract features, return temp feature data.

    Form fields:
      - piece_name: display name for the piece
      - boundaries: comma-separated MM.SS boundary values (e.g. "0.00,1.00,2.30").
                    Required when audio is provided; optional for MXL-only uploads
                    (sections will be derived from rehearsal marks instead).
      - musicxml:   optional MusicXML / .mxl file
      - audio:      optional WAV / MP3 file
      - pdf:        optional PDF score file

    Returns:
      { temp_id, music_name, available_views, feature_data }
    """
    has_mxl   = musicxml is not None and musicxml.filename not in (None, "")
    has_audio = audio    is not None and audio.filename    not in (None, "")
    has_pdf   = pdf      is not None and pdf.filename      not in (None, "")

    if not has_mxl and not has_audio:
        raise HTTPException(400, "At least one of musicxml or audio must be provided.")

    # Parse boundaries — required when audio is present, optional for MXL-only
    boundary_secs = _parse_boundaries(boundaries.strip()) if boundaries.strip() else []
    if has_audio and len(boundary_secs) < 2:
        raise HTTPException(400, "At least 2 boundary timestamps are required when audio is provided.")

    # n_segments / labels resolved later (after MXL parse) for MXL-only uploads
    temp_id   = str(uuid.uuid4())[:8]
    temp_name = f"temp_{temp_id}"

    available_views: list[str] = []

    # ── Temporary file storage ────────────────────────────────────────
    tmp_dir = Path(tempfile.mkdtemp(prefix="varivis_upload_"))

    try:
        mxl_path: Path | None = None
        audio_path: Path | None = None

        if has_mxl:
            ext = Path(musicxml.filename).suffix.lower() or ".mxl"
            mxl_path = tmp_dir / f"score{ext}"
            content = await musicxml.read()
            mxl_path.write_bytes(content)

        if has_audio:
            ext = Path(audio.filename).suffix.lower() or ".wav"
            audio_path = tmp_dir / f"audio{ext}"
            content = await audio.read()
            audio_path.write_bytes(content)

        # Save PDF to IMSLP_DIR so it can be served via /api/upload/temp_pdf/{temp_name}
        tmp_pdf_stem: str | None = None
        if has_pdf and pdf is not None:
            pdf_dest = IMSLP_DIR / f"{temp_name}.pdf"
            content = await pdf.read()
            pdf_dest.write_bytes(content)
            tmp_pdf_stem = temp_name

        # ── Build segments ─────────────────────────────────────────────
        # We'll produce a feature JSON with the same schema as extract_features.py
        # but only containing what we can compute from the uploaded files.

        segments_out: list[dict] = []
        mxl_sections: list[dict] | None = None

        # 1. MusicXML path: use _parse_mxl_symbolic on the temp file.
        #    We need to copy it to MUSICXML_DIR temporarily so the helper can find it.
        tmp_mxl_stem: str | None = None
        if has_mxl and mxl_path is not None:
            tmp_mxl_stem = temp_name
            dest = MUSICXML_DIR / f"{tmp_mxl_stem}{mxl_path.suffix}"
            shutil.copy(mxl_path, dest)
            try:
                mxl_sections = _parse_mxl_symbolic(tmp_mxl_stem)
            except Exception as e:
                print(f"  [upload] MusicXML parse failed: {e}")
                mxl_sections = None
            finally:
                # keep the copy so the frontend can reference it via existing endpoints
                pass  # will clean up at the end

        # Resolve n_segments / labels / boundary_secs for MXL-only (no boundaries given)
        if not boundary_secs:
            if mxl_sections is not None and len(mxl_sections) >= 1:
                # Build boundary_secs from MXL section durations
                t = 0.0
                mxl_boundary_secs = [0.0]
                for sec in mxl_sections:
                    t += sec.get("seg_dur_sec", 0.0)
                    mxl_boundary_secs.append(round(t, 3))
                boundary_secs = mxl_boundary_secs
                labels        = [sec["label"] for sec in mxl_sections]
                n_segments    = len(mxl_sections)
            else:
                # No sections detected — single placeholder segment
                boundary_secs = [0.0, 1.0]
                labels        = ["T"]
                n_segments    = 1
        else:
            n_segments = len(boundary_secs) - 1
            labels     = _auto_labels(n_segments)

        # 2. Audio path: load and slice by boundaries.
        audio_segments_y: list | None = None
        sr_out = 22050
        if has_audio and audio_path is not None:
            if librosa is None:
                raise HTTPException(500, "librosa is not installed on the server.")
            y_full, sr_out = librosa.load(str(audio_path), sr=None, mono=True)
            total_dur = len(y_full) / sr_out

            # Clamp the last boundary to audio length
            boundary_secs_clamped = [min(b, total_dur) for b in boundary_secs]

            audio_segments_y = []
            for i in range(n_segments):
                s = int(boundary_secs_clamped[i] * sr_out)
                e = int(boundary_secs_clamped[i + 1] * sr_out)
                e = min(e, len(y_full))
                audio_segments_y.append(y_full[s:e] if e > s else np.zeros(sr_out // 2))

        # 3. Build per-segment output
        for i, label in enumerate(labels):
            seg: dict = {
                "label":        label,
                "index":        i,
                "start_sec":    round(boundary_secs[i], 2),
                "end_sec":      round(boundary_secs[i + 1], 2) if i + 1 < len(boundary_secs) else round(boundary_secs[-1], 2),
                "duration_sec": round(boundary_secs[i + 1] - boundary_secs[i], 2) if i + 1 < len(boundary_secs) else 0.0,
                "features":     {},
            }

            # Audio features
            if audio_segments_y is not None and i < len(audio_segments_y):
                try:
                    seg["features"] = _extract_audio_segment(audio_segments_y[i], sr_out, label)
                except Exception as e:
                    print(f"  [upload] Audio feature extraction failed for {label}: {e}")
                    seg["features"] = {}

            # pitch_contour from MusicXML if no audio
            if not has_audio and mxl_sections is not None:
                pc_list = _extract_mxl_pitch_contour(mxl_sections)
                if i < len(pc_list):
                    seg["features"]["pitch_contour"] = pc_list[i]

            segments_out.append(seg)

        # 3b. Score pitch contour from MusicXML (score_beat_midi_relative — highest priority)
        #     Mirrors add_score_pitch.py so uploaded MXL produces the same priority-1 data
        #     as dataset pieces.  MXL is already copied to MUSICXML_DIR as tmp_mxl_stem.
        if has_mxl and tmp_mxl_stem is not None:
            try:
                import importlib.util as _ilu2
                _asp_path = Path(__file__).parent / "add_score_pitch.py"
                _asp_spec = _ilu2.spec_from_file_location("add_score_pitch", _asp_path)
                _asp      = _ilu2.module_from_spec(_asp_spec)
                _asp_spec.loader.exec_module(_asp)

                score_contours = _asp._build_score_contours(tmp_mxl_stem)
                if score_contours:
                    for seg in segments_out:
                        lk = _asp._label_key(seg["label"])
                        if lk in score_contours:
                            if "pitch_contour" not in seg["features"]:
                                seg["features"]["pitch_contour"] = {}
                            seg["features"]["pitch_contour"].update(score_contours[lk])
                            print(f"  [upload] score pitch → {seg['label']} beats={len(score_contours[lk].get('score_beat_midi', []))}")
            except Exception as _e:
                print(f"  [upload] score pitch contour failed: {_e}")

        # 4. Determine available_views
        if has_mxl:
            available_views += ["symbolic_heatmap"]
            if mxl_sections is not None and len(mxl_sections) >= 2:
                available_views += ["harmonic_function"]
        if has_audio:
            available_views += ["overview", "mentallandscape"]
        if has_mxl or has_audio:
            available_views.append("corpus_view")

        # Deduplicate preserving order
        seen: set[str] = set()
        av_dedup = []
        for v in available_views:
            if v not in seen:
                av_dedup.append(v)
                seen.add(v)
        available_views = av_dedup

        # 5. Build feature JSON (same schema as extract_features.py output)
        total_dur_out = boundary_secs[-1] - boundary_secs[0]
        feature_json: dict = {
            "metadata": {
                "file_name":          temp_name,
                "music_name":         piece_name,
                "composer":           "Uploaded",
                "period":             "",
                "instrument":         "",
                "variation_num":      n_segments - 1,  # exclude Theme
                "chord_annotation":   None,
                "sample_rate":        sr_out,
                "total_duration_sec": round(total_dur_out, 2),
                "compressed_frames":  64,
                "cof_order":          COF_ORDER_U,
                "cof_names":          COF_NAMES_U,
                "is_temp":            True,
                "available_views":    available_views,
                "mxl_stem":           tmp_mxl_stem,
            },
            "segments": segments_out,
        }

        # 6. Save to FEATURE_DIR so existing /api/features/ endpoint can serve it
        out_path = FEATURE_DIR / f"{temp_name}.json"
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(feature_json, fh, ensure_ascii=False, indent=2)

        return {
            "temp_id":         temp_id,
            "temp_name":       temp_name,
            "music_name":      piece_name,
            "available_views": available_views,
            "mxl_stem":        tmp_mxl_stem,
            "pdf_stem":        tmp_pdf_stem,
            "n_segments":      n_segments,
            "labels":          labels,
        }

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@app.get("/api/upload/temp_pdf/{temp_name}")
def serve_temp_pdf(temp_name: str):
    """Serve a temporary uploaded PDF score."""
    if not temp_name.startswith("temp_"):
        raise HTTPException(400, "Invalid temp name.")
    pdf_path = IMSLP_DIR / f"{temp_name}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, f"No PDF found for {temp_name}")
    return FileResponse(str(pdf_path), media_type="application/pdf")


@app.delete("/api/upload/temp/{temp_name}")
def delete_temp_upload(temp_name: str):
    """Remove a temporary upload's feature file, MusicXML copy, and PDF."""
    if not temp_name.startswith("temp_"):
        raise HTTPException(400, "Invalid temp name.")

    feat_path = FEATURE_DIR / f"{temp_name}.json"
    if feat_path.exists():
        feat_path.unlink()

    # Remove any MusicXML copy
    for ext in (".mxl", ".xml", ".musicxml"):
        p = MUSICXML_DIR / f"{temp_name}{ext}"
        if p.exists():
            p.unlink()

    # Remove PDF copy
    pdf_path = IMSLP_DIR / f"{temp_name}.pdf"
    if pdf_path.exists():
        pdf_path.unlink()

    return {"deleted": temp_name}
