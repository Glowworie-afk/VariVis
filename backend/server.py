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

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

# ── 路径配置 ─────────────────────────────────────────────────────────
BACKEND_DIR  = Path(__file__).parent
BASE_DIR     = BACKEND_DIR.parent
FEATURE_DIR  = BACKEND_DIR / "features"
ANNOTATION   = BACKEND_DIR / "data" / "TV_annotation.xlsx"
AUDIO_DIR    = BASE_DIR / "TV_dataset_audio"
IMSLP_DIR    = BASE_DIR / "IMSLP"
MIDI_DIR     = BASE_DIR / "TV_MIDI"

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
        results.append({
            "file_name":    name,
            "music_name":   str(row.get("music_name", "")),
            "composer":     str(row.get("composer",   "")),
            "instrument":   str(row.get("instrument", "")),
            "period":       str(row.get("period",     "")),
            "folder":       str(row.get("folder",     "")),
            "extracted":    (FEATURE_DIR / f"{name}.json").exists(),
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

def _normalize_for_match(text: str) -> str:
    """Normalize text for fuzzy matching against IMSLP filenames."""
    # Convert standalone K265 → KV265
    text = re.sub(r'\bK(\d+)\b', r'KV\1', text, flags=re.IGNORECASE)
    # Strip IMSLP/PMLP number prefixes
    text = re.sub(r'IMSLP\d+', '', text, flags=re.IGNORECASE)
    text = re.sub(r'PMLP\d+', '', text, flags=re.IGNORECASE)
    # Collapse separators
    text = re.sub(r'[_\-]', ' ', text)
    return text.lower().strip()


def _best_imslp_match(file_name: str, music_name: str) -> tuple[str | None, float, list[str]]:
    """Return (best_pdf_filename, score, all_pdfs)."""
    if not IMSLP_DIR.exists():
        return None, 0.0, []
    pdfs = [f.name for f in sorted(IMSLP_DIR.iterdir()) if f.suffix.lower() == '.pdf']
    if not pdfs:
        return None, 0.0, []

    query = _normalize_for_match(f"{file_name} {music_name}")
    kv_re = re.search(r'kv?(\d+)', query, re.IGNORECASE)
    kv_num = kv_re.group(1) if kv_re else None

    # Extract composer tokens from query
    composer_tokens = ['mozart', 'beethoven', 'haydn', 'schubert', 'brahms',
                       'chopin', 'liszt', 'schumann', 'handel', 'bach']

    best_score = -1.0
    best_file: str | None = None
    for pdf in pdfs:
        norm = _normalize_for_match(pdf.replace('.pdf', ''))
        score = difflib.SequenceMatcher(None, query, norm).ratio()
        # Strong bonus when KV/opus numbers agree
        if kv_num and re.search(rf'kv{kv_num}', norm):
            score = min(score + 0.5, 1.0)
        # Small bonus for matching composer
        for tok in composer_tokens:
            if tok in query and tok in norm:
                score = min(score + 0.1, 1.0)
                break
        if score > best_score:
            best_score = score
            best_file = pdf

    return best_file, round(best_score, 3), pdfs


# ── /api/score/match ─────────────────────────────────────────────────

@app.get("/api/score/match")
def match_score(file_name: str = "", music_name: str = ""):
    """
    Fuzzy-match a piece (identified by file_name + music_name)
    to the PDF files available in the IMSLP/ directory.
    Returns: { matched, score, available }
    """
    best, score, pdfs = _best_imslp_match(file_name, music_name)
    return {"matched": best, "score": score, "available": pdfs}


# ── Music-theory analysis system prompt ─────────────────────────────

_SCORE_SYSTEM = """你是一位音乐理论分析助手，擅长从乐谱图像中提取和声、旋律、装饰音与音符密度信息，并以简洁统一的语言输出结构化分析表格。

词汇约束表（强制使用以下词汇，不得自行发明描述）

和声功能：主、属、下属、转调、半音经过音、cresc.、f／p／fp、织体技法、和声节奏
旋律走向：波浪形、拱形、级进、跳进、切分节奏、附点、音域
装饰音：  tr、倚音、回音、波音、延长记号、无、无法从乐谱确认
音符密度：音符密度、书写值、十六分音符、三十二分音符、三连音、基准

输出格式要求

以 Markdown 表格输出，列顺序固定为：
段落 | 和声功能 | 旋律走向 | 装饰音 | 音符密度

规则：
1. 每格不超过两句话
2. 和声功能：只写功能级数组合，如"主–属""主–属–下属"，附加转调或力度标注
3. 旋律走向：先写轮廓词（波浪形／拱形），再写运动方式（级进／跳进），再写音域特征
4. 装饰音：列出符号名称＋约出现小节，无则写"无"
5. 音符密度：写"约 X 音／小节"，首段注明为基准，其余写"主题的 N 倍"；Adagio 或书写值偏高时加注"但速度最慢"

分析规则

仅描述乐谱中明确可见的内容：
- 和声：依据调号与临时变音符号判断，无法确认的和弦写"无法从乐谱确认"
- 旋律：依据音符走向判断轮廓，无法辨认时写"无法从乐谱确认"
- 装饰音：仅计入乐谱明确印出的符号（tr、倚音斜线、回音括号等），不推断未标注的演奏习惯
- 音符密度：目测估算两手音符总数除以小节数，标注为约略值；Adagio 段落加注书写值说明"""


# ── /api/score/analyze — SSE stream ─────────────────────────────────

@app.get("/api/score/analyze")
async def analyze_score_stream(
    file_name: str = "",
    music_name: str = "",
    pdf_name: str = "",
):
    """
    SSE endpoint: convert PDF pages to images and stream a Claude analysis.

    Events:
        data: STATUS:<msg>     — progress info
        data: TEXT:<chunk>     — streamed analysis text (\\n encoded as \\\\n)
        data: DONE             — complete
        data: ERROR:<msg>      — failure
    """

    async def stream():
        import threading

        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            yield "data: ERROR:GEMINI_API_KEY 未设置。请在终端中执行: export GEMINI_API_KEY=AIza...\n\n"
            return

        # ── Resolve PDF path ─────────────────────────────────────────
        if pdf_name:
            pdf_path = IMSLP_DIR / pdf_name
        else:
            best, _, _ = _best_imslp_match(file_name, music_name)
            if not best:
                yield "data: ERROR:No matching score found in IMSLP/ directory\n\n"
                return
            pdf_path = IMSLP_DIR / best

        if not pdf_path.exists():
            yield f"data: ERROR:Score file not found: {pdf_path.name}\n\n"
            return

        try:
            import fitz  # PyMuPDF
        except ImportError:
            yield "data: ERROR:PyMuPDF not installed. Run: pip install pymupdf\n\n"
            return

        try:
            import google.generativeai as genai
        except ImportError:
            yield "data: ERROR:google-generativeai not installed. Run: pip install google-generativeai\n\n"
            return

        # ── Convert PDF pages to raw PNG bytes ───────────────────────
        yield f"data: STATUS:正在将 {pdf_path.name} 转换为图像…\n\n"
        doc = fitz.open(str(pdf_path))
        page_count = len(doc)
        page_pngs: list[bytes] = []
        mat = fitz.Matrix(1.5, 1.5)   # ~108 dpi — 同样可识别乐谱，token 用量约为 2x 的 56%
        for idx in range(page_count):
            pix = doc[idx].get_pixmap(matrix=mat, alpha=False)
            page_pngs.append(pix.tobytes("jpeg", jpg_quality=85))  # JPEG 进一步压缩体积
        doc.close()

        yield f"data: STATUS:已载入 {page_count} 页，正在调用 Gemini 分析…\n\n"

        # ── Build Gemini content parts ────────────────────────────────
        # Each image is passed as an inline blob: {"mime_type": ..., "data": bytes}
        parts: list = []
        for png_bytes in page_pngs:
            parts.append({"mime_type": "image/jpeg", "data": png_bytes})
        parts.append(
            f"以上是乐谱图像（共 {page_count} 页），"
            f"曲目信息：{music_name or file_name}。\n"
            "请按系统提示格式逐段分析，输出完整 Markdown 表格，"
            "并在表格下方附词汇解释区块。"
        )

        # ── Stream from Gemini (sync SDK → async via queue) ──────────
        loop = asyncio.get_event_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def _run_gemini():
            try:
                genai.configure(api_key=api_key)
                model = genai.GenerativeModel(
                    model_name="gemini-2.0-flash-lite",
                    system_instruction=_SCORE_SYSTEM,
                )
                response = model.generate_content(parts, stream=True)
                for chunk in response:
                    text = getattr(chunk, "text", None)
                    if text:
                        asyncio.run_coroutine_threadsafe(
                            queue.put(("text", text)), loop
                        )
            except Exception as exc:
                asyncio.run_coroutine_threadsafe(
                    queue.put(("error", str(exc))), loop
                )
            finally:
                asyncio.run_coroutine_threadsafe(
                    queue.put(("done", None)), loop
                )

        threading.Thread(target=_run_gemini, daemon=True).start()

        while True:
            kind, payload = await queue.get()
            if kind == "done":
                break
            if kind == "error":
                yield f"data: ERROR:{payload}\n\n"
                return
            if kind == "text":
                escaped = payload.replace("\\", "\\\\").replace("\n", "\\n")
                yield f"data: TEXT:{escaped}\n\n"

        yield "data: DONE\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── MIDI Analysis ────────────────────────────────────────────────────

def _extract_k_number(text: str) -> "str | None":
    """'WAMozart_K265_1' → '265'"""
    m = re.search(r"[Kk][Vv]?\.?(\d+)", text)
    return m.group(1) if m else None


def _find_midi_file(file_name: str) -> "Path | None":
    """Fuzzy-match file_name to a .mid in TV_MIDI/ via K-number."""
    if not MIDI_DIR.exists():
        return None
    k_num = _extract_k_number(file_name)
    if not k_num:
        return None
    pattern = re.compile(rf"K\.?\s*{re.escape(k_num)}(?!\d)", re.IGNORECASE)
    for p in sorted(MIDI_DIR.glob("*.mid")):
        if pattern.search(p.name):
            return p
    return None


def _parse_midi_analysis(midi_path: "Path") -> dict:
    """Parse MIDI → per-variation stats for all 5 structural dimensions."""
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

    # ── Strategy 1: look up annotation ──
    k_num = _extract_k_number(midi_path.name)
    if k_num and ANNOTATION.exists():
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

    # ── Strategy 2: hardcoded fallback ──
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


@app.get("/api/midi/{file_name}")
def get_midi_analysis(file_name: str):
    """
    Fuzzy-match file_name → TV_MIDI/ via K-number, parse with mido,
    return 5-dimension structural analysis (Theme + 12 Variations).
    """
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {
            "matched":   False,
            "file_name": file_name,
            "message":   f"No matching MIDI found for '{file_name}' in TV_MIDI/",
        }
    result = _parse_midi_analysis(midi_path)
    result["file_name"] = file_name
    return result
