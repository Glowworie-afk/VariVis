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
from fastapi import FastAPI, HTTPException, UploadFile
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


# ── Page-map auto-detection helpers ──────────────────────────────────

def _roman_to_int(s: str) -> "int | None":
    vals = {'I':1,'V':5,'X':10,'L':50,'C':100,'D':500,'M':1000}
    s = s.upper().strip()
    if not re.fullmatch(r'[IVXLCDM]+', s):
        return None
    total, prev = 0, 0
    for ch in reversed(s):
        v = vals.get(ch, 0)
        if v == 0:
            return None
        total += v if v >= prev else -v
        prev = v
    return total if 1 <= total <= 50 else None


def _automap_pdf(pdf_path: Path, dpi: int = 150) -> dict:
    """
    OCR every page of a PDF and detect TEMA/THEME and VAR I…XII markers.
    Returns { label: [page_nums...] } (1-based), plus metadata.
    """
    try:
        import pdf2image
        import pytesseract
    except ImportError:
        return {"error": "pdf2image or pytesseract not installed"}

    images = pdf2image.convert_from_path(str(pdf_path), dpi=dpi)
    n_pages = len(images)

    # Patterns
    THEME_RE = re.compile(r'\b(TEMA|THEME|THEMA)\b', re.I)
    VAR_RE   = re.compile(
        r'(?:VAR[A-Z.]?\s*|(?<![A-Z])AR[.\s]+)'
        r'([IVXLCDM]{1,6}|\d{1,2})',
        re.I
    )
    SOLO_RE  = re.compile(r'(?:^|\n)\s*([IVXLCDM]{1,6})\.?\s*(?:\n|$)', re.M)

    page_labels: list[list[str]] = []
    page_text:   list[str]       = []

    for img in images:
        text = pytesseract.image_to_string(img, lang='eng+deu', config='--psm 6')
        page_text.append(text)
        found: list[str] = []

        if THEME_RE.search(text):
            found.append('T')

        for m in VAR_RE.finditer(text):
            raw = m.group(1).upper()
            n   = _roman_to_int(raw) or (int(raw) if raw.isdigit() else None)
            if n and 1 <= n <= 50:
                lbl = f'V{n}'
                if lbl not in found:
                    found.append(lbl)

        if not any(l.startswith('V') for l in found):
            for m in SOLO_RE.finditer(text):
                raw = m.group(1).upper()
                n   = _roman_to_int(raw)
                if n and 1 <= n <= 50:
                    lbl = f'V{n}'
                    if lbl not in found:
                        found.append(lbl)

        page_labels.append(found)

    # Build first_page map: label → first page it appears on
    first_page: dict[str, int] = {}
    for pg, labels in enumerate(page_labels, start=1):
        for lbl in labels:
            if lbl not in first_page:
                first_page[lbl] = pg

    if not first_page:
        return {
            "mapping": {},
            "total_pages": n_pages,
            "detected_labels": [],
            "page_labels": [{"page": i+1, "labels": ls} for i, ls in enumerate(page_labels)],
        }

    # Assign page ranges: each label spans from its first page to just before the next label starts
    ordered = sorted(first_page.items(), key=lambda x: x[1])
    mapping: dict[str, list[int]] = {}
    for i, (lbl, start) in enumerate(ordered):
        end = ordered[i+1][1] if i+1 < len(ordered) else n_pages
        mapping[lbl] = list(range(start, end + 1))

    return {
        "mapping":          mapping,
        "total_pages":      n_pages,
        "detected_labels":  list(first_page.keys()),
        "page_labels":      [{"page": i+1, "labels": ls} for i, ls in enumerate(page_labels)],
    }


@app.get("/api/score/automap/{file_name}")
async def automap_score(file_name: str):
    """
    OCR the matched PDF and auto-detect which pages correspond to Theme / each Variation.
    Returns the suggested mapping + per-page detection details.
    Runs synchronously (may take 10–30 seconds for large PDFs) — call from background.
    """
    music_name = ""
    try:
        df = pd.read_excel(ANNOTATION)
        df["folder"] = df["folder"].ffill()
        row = df[df["file_name (folderName_number)"] == file_name]
        if not row.empty:
            music_name = str(row.iloc[0].get("music_name", ""))
    except Exception:
        pass

    best, score, _ = _best_imslp_match(file_name, music_name)
    if not best or score < 0.3:
        raise HTTPException(404, f"No PDF matched for '{file_name}'")

    pdf_path = IMSLP_DIR / best
    result   = _automap_pdf(pdf_path)
    result["pdf_name"] = best
    return result


# ── /api/score/pagemap — store page→segment mapping ──────────────────

def _pagemap_path(file_name: str) -> Path:
    """e.g. WAMozart_K265_1 → IMSLP/mozart_k265.pagemap.json"""
    base = re.sub(r"_\d+$", "", file_name)
    stem = _SCORE_MAP.get(base, base.lower())
    return IMSLP_DIR / f"{stem}.pagemap.json"


@app.get("/api/score/pagemap/{file_name}")
def get_pagemap(file_name: str):
    """
    Return saved page→segment mapping for this piece.
    Format: { "T": [1, 2], "V1": [3, 4], "V2": [5, 6], ... }
    Also returns total page count from the matched PDF (via pypdf).
    """
    path = _pagemap_path(file_name)
    mapping: dict = {}
    if path.exists():
        try:
            mapping = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            mapping = {}

    # Try to get total page count
    total_pages: int | None = None
    try:
        import pypdf
        pdf_path_found = None
        music_name = ""
        try:
            df = pd.read_excel(ANNOTATION)
            df["folder"] = df["folder"].ffill()
            row = df[df["file_name (folderName_number)"] == file_name]
            if not row.empty:
                music_name = str(row.iloc[0].get("music_name", ""))
        except Exception:
            pass
        best, score, _ = _best_imslp_match(file_name, music_name)
        if best and score >= 0.3:
            pdf_path_found = IMSLP_DIR / best
        if pdf_path_found and pdf_path_found.exists():
            reader = pypdf.PdfReader(str(pdf_path_found))
            total_pages = len(reader.pages)
    except Exception:
        pass

    return {"mapping": mapping, "total_pages": total_pages}


@app.post("/api/score/pagemap/{file_name}")
async def save_pagemap(file_name: str, request: "Request"):
    """
    Save page→segment mapping.
    Body: { "T": [1, 2], "V1": [3, 4], ... }
    """
    from fastapi import Request
    body = await request.json()
    path = _pagemap_path(file_name)
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"saved": True, "path": str(path)}


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


def _annotated_cache_path(file_name: str) -> Path:
    """Cache path for annotated (skeleton-coloured) XML, stored in MUSICXML_DIR.
    Works for both plain stems ("WAMozart_K265") and filenames ("WAMozart_K265.mxl").
    """
    stem = Path(file_name).stem if "." in file_name else file_name
    stem = re.sub(r"_\d+$", "", stem)   # strip trailing version index if any
    return MUSICXML_DIR / f"{stem}.annotated.xml"


@app.get("/api/score/annotated/{file_name}")
def get_annotated_score(file_name: str):
    """
    Return MusicXML with skeleton notes (highest-pitch per 0.5-beat slot)
    coloured red (#ef4444).  Result is cached on disk so the slow music21
    parse only runs once per piece.

    Source priority (same as /api/score/musicxml):
      1. Cached annotated XML  (instant)
      2. Cached plain XML      → annotate + save
      3. Local MXL/XML         → parse → annotate + save
      4. MIDI conversion       → parse → annotate + save
    """
    ann_cache = _annotated_cache_path(file_name)

    # ── 1. Already annotated ─────────────────────────────────────────
    if ann_cache.exists():
        return {
            "matched":   True,
            "source":    "cache",
            "file_name": file_name,
            "xml":       ann_cache.read_text(encoding="utf-8"),
        }

    try:
        import music21
        from music21 import note as m21note, chord as m21chord
    except ImportError:
        raise HTTPException(500, "music21 not installed. Run: pip install music21")

    # ── 2–5. Resolve & load score ────────────────────────────────────
    # Priority:
    #   2. MusicXML/  directory  (.mxl / .xml)   ← authoritative source
    #   3. scores/    plain-XML cache             (legacy, may be MIDI-derived)
    #   4. scores/    local MXL / XML
    #   5. MIDI fallback
    score = None
    source_label = ""

    musicxml_path = _find_musicxml(file_name)
    plain_cache   = _score_cache_path(file_name)
    local_path    = _find_local_score(file_name)
    midi_path     = _find_midi_file(file_name)

    if musicxml_path is not None:
        try:
            if musicxml_path.suffix.lower() == ".mxl":
                xml_bytes = _extract_mxl(musicxml_path)
                score = music21.converter.parseData(xml_bytes, format="musicxml")
            else:
                score = music21.converter.parse(str(musicxml_path))
            source_label = f"musicxml:{musicxml_path.name}"
        except Exception as e:
            score = None  # fall through to next source
    if score is None and plain_cache.exists():
        score = music21.converter.parse(str(plain_cache))
        source_label = "cache"
    if score is None and local_path is not None:
        score = music21.converter.parse(str(local_path))
        source_label = f"local:{local_path.name}"
    if score is None and midi_path is not None:
        score = music21.converter.parse(str(midi_path))
        source_label = f"midi:{midi_path.name}"

    if score is None:
        return {
            "matched":   False,
            "file_name": file_name,
            "message":   "No MusicXML or MIDI found for this piece.",
        }

    # ── Identify skeleton notes via shortest-path reduction ─────────
    # Uses Wang et al. (ISMIR 2025) graph algorithm:
    # top voice → remove ornaments → chord lookup → Dijkstra → skeleton PCs.
    # We then colour matching notes in the score red.
    SKELETON_COLOR = "#ef4444"

    try:
        key_obj = score.analyze('key')
    except Exception:
        import music21 as _m21
        key_obj = _m21.key.Key('C')

    # Run the graph-based skeleton extraction over the full score
    all_measures = list(score.parts[0].getElementsByClass('Measure')) if score.parts else []
    skeleton_notes = _extract_skeleton(score, 0, len(all_measures), key_obj)

    # Build a set of (measure_number, beat, pitch_class) for O(1) lookup
    # measure_rel → actual measure number offset by start measure number
    start_measure_num = all_measures[0].number if all_measures else 1
    skeleton_keys: set[tuple] = set()
    for sn in skeleton_notes:
        mn = start_measure_num + sn['measure_rel']
        skeleton_keys.add((mn, round(sn['beat'], 3), sn['pc']))

    # Walk every part and colour notes whose (measure, beat, pc) match skeleton.
    # Use recurse() so notes inside Voice sub-streams are also visited —
    # _extract_top_voice uses recurse() too, so the beat offsets stay aligned.
    # Use el.offset (0-based within measure) rather than el.beat-1.0 to avoid
    # off-by-one issues in compound/pickup measures.
    for part in score.parts:
        for measure in part.getElementsByClass("Measure"):
            mn = measure.number
            for el in measure.recurse().notesAndRests:
                if el.isRest:
                    continue
                try:
                    if el.duration.isGrace:
                        continue
                except Exception:
                    pass
                beat_0 = round(float(el.offset), 3)
                note_iter = el.notes if el.isChord else [el]
                for n in note_iter:
                    try:
                        pc = n.pitch.midi % 12
                    except Exception:
                        continue
                    if (mn, beat_0, pc) in skeleton_keys:
                        try:
                            n.style.color = SKELETON_COLOR
                        except Exception:
                            pass

    # ── Export annotated XML ─────────────────────────────────────────
    try:
        exporter  = music21.musicxml.m21ToXml.GeneralObjectExporter(score)
        xml_bytes = exporter.parse()
        xml_str   = xml_bytes.decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(500, f"music21 export failed: {exc}")

    ann_cache.write_text(xml_str, encoding="utf-8")

    return {
        "matched":   True,
        "source":    source_label,
        "file_name": file_name,
        "xml":       xml_str,
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

    result = []
    for off, label in raw:
        idx = offset_to_idx.get(off, 0)
        # Normalise label to match MIDI convention
        low = label.lower()
        if low in ("tema", "theme"):
            norm = "Theme"
        elif low.startswith("coda"):
            norm = "Coda"
        else:
            m2 = re.search(r"(\d+)", label)
            norm = f"Var.{int(m2.group(1)):02d}" if m2 else label
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


def _extract_skeleton(score, start_idx: int, end_idx: int, key_obj) -> list:
    """
    Melody skeleton extraction via shortest-path graph algorithm.

    Implements Wang et al. "Automatic Melody Reduction via Shortest Path Finding"
    (ISMIR 2025).  Pipeline:
      1. Extract top voice (highest pitch per beat in the top part)
      2. Remove grace-note ornaments
      3. Build chord lookup from chordified score
      4. Run Dijkstra shortest-path on the note graph with tonal + temporal costs
         modulated by per-note importance (pitch extremes, metric position,
         duration, chord-tone status)
      5. Return skeleton note list (~1-2 notes per measure)
    """
    parts = score.parts
    if not parts:
        return []
    top_part = parts[0]
    measures  = list(top_part.getElementsByClass('Measure'))
    end_idx   = min(end_idx, len(measures))

    # 1. Top voice
    voice = _extract_top_voice(measures, start_idx, end_idx)
    if not voice:
        return []

    # 2. Remove grace-note-level ornaments only
    voice = _remove_ornaments(voice)
    if not voice:
        return []

    # 3. Chord lookup for harmony importance
    chord_lookup = _build_chord_lookup(score)

    # 4. Detect beats per measure from first measure's time signature
    ts = measures[start_idx].getContextByClass('TimeSignature') if measures else None
    bpm = float(ts.numerator) if ts else 4.0

    # 5. Shortest-path reduction
    skeleton = _shortest_path_skeleton(voice, chord_lookup,
                                       beats_per_measure=bpm,
                                       max_measure_span=2)

    # Annotate diatonic flag for downstream use
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

    return {
        "matched":       True,
        "file_name":     file_name,
        "beats_per_bar": beats_per_bar,
        "total_beats":   round(total_beats, 2),
        "total_bars":    total_bars,
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


# ── MDA Penalty Analysis (Almada 2023, Ch.1-3) ─────────────────────────────

WP_PITCH = [15, 15, 40, 25, 5]   # weights: [v1, v2, v3, v4, v5]
WT_TEMPO = [15, 45, 30, 10]       # weights: [v1, v2, v3, v4]
WH_HARM  = [45, 25, 15, 10, 5]   # weights: 5 harmonic attributes
KS_MAJ   = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]
KS_MIN   = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]


def _mda_extract_melody(all_notes: list, s_beat: float, e_beat: float) -> list:
    """Return top (highest) note per integer beat in [s_beat, e_beat)."""
    seg = [n for n in all_notes if s_beat <= n["beat"] < e_beat]
    by_beat: dict = collections.defaultdict(list)
    for n in seg:
        by_beat[int(n["beat"] - s_beat)].append(n)
    return [
        {"pitch": max(by_beat[b], key=lambda x: x["pitch"])["pitch"],
         "beat_rel": b,
         "dur": max(by_beat[b], key=lambda x: x["pitch"])["dur_sec"]}
        for b in range(int(e_beat - s_beat)) if by_beat[b]
    ]


def _mda_pitch_penalty(theme_mel: list, var_mel: list) -> float:
    """Almada Ch.3 kp — normalised pitch penalty in [0,1]."""
    n = min(len(theme_mel), len(var_mel))
    if n < 2:
        return 0.0
    pm, cm = theme_mel[:n], var_mel[:n]
    p1 = [x["pitch"] for x in pm]; c1 = [x["pitch"] for x in cm]
    p2 = [x % 12 for x in p1];    c2 = [x % 12 for x in c1]
    def intervals(seq): return [seq[i+1]-seq[i] for i in range(len(seq)-1)]
    pi, ci = intervals(p1), intervals(c1)
    def ranks(seq):
        su = sorted(set(seq)); rm = {v: i for i, v in enumerate(su)}
        return [rm[x] for x in seq]
    p4, c4 = ranks(p1), ranks(c1)

    v1 = [abs(c1[i]-p1[i]) for i in range(n)]
    v2 = [min(abs(c2[i]-p2[i]), 12-abs(c2[i]-p2[i])) for i in range(n)]
    v3 = [abs(ci[i]-pi[i]) for i in range(min(len(pi),len(ci)))]
    v4 = [abs(c4[i]-p4[i]) for i in range(n)]
    p5 = max(p1)-min(p1); c5 = max(c1)-min(c1); v5 = abs(c5-p5)

    # Rule 1: octave transpositions in intervals → reduce 12→4
    v3 = [4 if x == 12 else x for x in v3]
    # Rule 2: uniform transposition in v1 → replace all with 2
    if v1 and len(set(v1)) == 1 and v1[0] > 0:
        v1 = [2]*n; v2 = [2]*n
    # Rule 3: inversion → ~double the original intervals → set to 3
    if v3 and pi and sum(1 for i in range(len(v3)) if abs(v3[i]-2*abs(pi[i]))<2) > len(v3)*0.6:
        v3 = [3]*len(v3)
    # Rule 4: contour inversion → sum of ranks is constant → set v4 to 1s
    if n > 1 and len(set(p4[i]+c4[i] for i in range(n))) == 1:
        v4 = [1]*n

    vp = [sum(v1), sum(v2), sum(v3), sum(v4), v5]
    kp_raw = sum(vp[i]*WP_PITCH[i] for i in range(5))
    kp_max = (n*12*15 + n*6*15 + max(n-1,1)*12*40 + n*(n//2)*25 + 24*5) or 1
    return min(1.0, kp_raw / kp_max)


def _mda_temporal_penalty(theme_mel: list, var_mel: list, bpb: int) -> float:
    """Almada Ch.3 kt — normalised temporal penalty in [0,1]."""
    n = min(len(theme_mel), len(var_mel))
    if n < 2:
        return 0.0
    pm, cm = theme_mel[:n], var_mel[:n]

    def quant(dur): return round(dur * 2) / 2  # quantise to 0.5 beat
    pt1 = [quant(x["dur"]) for x in pm]; ct1 = [quant(x["dur"]) for x in cm]
    def ioi(mel): return [mel[i+1]["beat_rel"]-mel[i]["beat_rel"] for i in range(len(mel)-1)]
    pi2 = [quant(x) for x in ioi(pm)]; ci2 = [quant(x) for x in ioi(cm)]
    pt3 = [x["beat_rel"] % bpb for x in pm]; ct3 = [x["beat_rel"] % bpb for x in cm]
    span_p = pm[-1]["beat_rel"] + pm[-1]["dur"]; span_c = cm[-1]["beat_rel"] + cm[-1]["dur"]

    v1 = [abs(ct1[i]-pt1[i]) for i in range(n)]
    m2 = min(len(pi2), len(ci2))
    v2 = [abs(ci2[i]-pi2[i]) for i in range(m2)]
    v3 = [abs(ct3[i]-pt3[i]) for i in range(n)]
    v4 = abs(span_c - span_p)

    # Rule 5: augmentation / diminution (all durations scaled by constant)
    if pt1 and ct1 and pt1[0] > 0:
        ratios = [ct1[i]/pt1[i] for i in range(n) if pt1[i] > 0]
        if ratios and len(set(round(r, 1) for r in ratios)) == 1 and abs(ratios[0]-1.0) > 0.1:
            v1 = [1]*n; v2 = [1]*max(len(v2),1); v4 = 0.5

    vt = [sum(v1), sum(v2), sum(v3), v4]
    kt_raw = sum(vt[i]*WT_TEMPO[i] for i in range(4))
    kt_max = n*bpb*15 + n*bpb*45 + n*(bpb-1)*30 + n*bpb*0.5*10 or 1
    return min(1.0, kt_raw / kt_max)


def _mda_harmonic_penalty(all_notes: list, s_t: float, e_t: float,
                           s_v: float, e_v: float) -> float:
    """Almada Ch.3 kh — normalised harmonic penalty in [0,1]."""
    def chroma_key(note_list):
        pc = [0.0]*12
        for n in note_list: pc[n["pitch"] % 12] += 1
        s = sum(pc) or 1; pc = [v/s for v in pc]
        mu_c = sum(pc)/12; ss_c = sum((x-mu_c)**2 for x in pc) or 1e-9
        br, br_root, br_mode = -999.0, 0, "major"
        for root in range(12):
            for mode, prof in (("major",KS_MAJ),("minor",KS_MIN)):
                rot = [prof[(j-root)%12] for j in range(12)]
                mu_p = sum(rot)/12
                num = sum((rot[j]-mu_p)*(pc[j]-mu_c) for j in range(12))
                den = math.sqrt(sum((x-mu_p)**2 for x in rot)*ss_c)
                r = num/den if den > 0 else 0.0
                if r > br: br, br_root, br_mode = r, root, mode
        return pc, br_root, br_mode

    t_notes = [n for n in all_notes if s_t <= n["beat"] < e_t]
    v_notes = [n for n in all_notes if s_v <= n["beat"] < e_v]
    if not t_notes or not v_notes:
        return 0.0

    pc_t, root_t, mode_t = chroma_key(t_notes)
    pc_v, root_v, mode_v = chroma_key(v_notes)

    h1 = 0 if min(abs(root_v-root_t), 12-abs(root_v-root_t)) <= 1 else 1
    h2 = 0 if mode_t == mode_v else 1

    def tonic_p(pc, r, m):
        pcs = {r%12,(r+(3 if m=="minor" else 4))%12,(r+7)%12}
        return sum(pc[p] for p in pcs)
    def dom_p(pc, r):
        return sum(pc[(r+i)%12] for i in (7,11,2))

    h3 = 0 if abs(tonic_p(pc_t,root_t,mode_t)-tonic_p(pc_v,root_v,mode_v)) < 0.15 else 1
    h4 = 0 if abs(dom_p(pc_t,root_t)-dom_p(pc_v,root_v)) < 0.15 else 1
    dot = sum(pc_t[i]*pc_v[i] for i in range(12))
    mt = math.sqrt(sum(x*x for x in pc_t)); mv = math.sqrt(sum(x*x for x in pc_v))
    cos_sim = dot/(mt*mv) if mt*mv > 0 else 1.0
    h5 = 0 if cos_sim >= 0.85 else 1

    vh = [h1, h2, h3, h4, h5]
    return sum(vh[i]*WH_HARM[i] for i in range(5)) / 100.0


def _mda_similarity_band(k: float) -> str:
    """Map penalty k to similarity band (Almada Table 1.1, π/8 increments)."""
    if k <= 0:    return "identity"
    alpha = math.degrees(math.atan((1-k)/k))
    if alpha > 67.5: return "high"
    if alpha > 45.0: return "medium-high"
    if alpha > 22.5: return "medium-low"
    if alpha > 0:    return "low"
    return "null"


def _mda_var_type(kp: float, kt: float, kh: float) -> str:
    """Classify dominant transformation domain (Almada Ch.2 & 4)."""
    vals = {"melodic": kp, "rhythmic": kt, "harmonic": kh}
    dom = max(vals, key=vals.get)
    sec = sorted(vals.values())[-2]
    return "hybrid" if vals[dom] - sec < 0.06 else dom


def _compute_mda_analysis(midi_path: "Path", n_variations: int | None = None) -> dict:
    """Full MDA penalty analysis: kp, kt, kh, k, band, type per segment."""
    if mido is None:
        raise HTTPException(500, "mido not installed")

    mid = mido.MidiFile(str(midi_path))
    tpb = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    # Build note list (same as _parse_midi_analysis)
    notes: list[dict] = []
    active: dict = {}
    abs_t = 0; bpb = 3
    for msg in merged:
        abs_t += msg.time
        if msg.type == "time_signature": bpb = msg.numerator
        if msg.type == "note_on" and msg.velocity > 0:
            active[(msg.note, msg.channel)] = (abs_t, msg.velocity)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            key = (msg.note, msg.channel)
            if key in active:
                on_t, _ = active.pop(key)
                notes.append({
                    "pitch": msg.note,
                    "beat": on_t / tpb,
                    "dur_sec": max(0.01, (abs_t - on_t) / tpb),
                })
    if not notes:
        raise HTTPException(422, "No notes in MIDI")
    notes.sort(key=lambda n: n["beat"])

    total_bars = int(max(n["beat"] for n in notes) / bpb) + 1

    # Determine segment boundaries
    n_segs = (n_variations + 1) if n_variations else 13
    step = total_bars / n_segs
    var_starts = [round(i * step) * bpb for i in range(n_segs)]
    var_ends   = var_starts[1:] + [int(max(n["beat"] for n in notes)) + 1]
    labels     = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_segs)]

    # Extract melodies
    melodies = [_mda_extract_melody(notes, s, e) for s, e in zip(var_starts, var_ends)]
    theme_mel = melodies[0]
    s_theme, e_theme = var_starts[0], var_ends[0]

    segments_out = []
    for i, (mel, lbl, s_beat, e_beat) in enumerate(
            zip(melodies, labels, var_starts, var_ends)):
        if i == 0:
            segments_out.append({
                "label": lbl, "kp": 0.0, "kt": 0.0, "kh": 0.0, "k": 0.0,
                "alpha": 90.0, "band": "identity", "type": "reference",
                "melody_len": len(mel),
            })
            continue

        kp = _mda_pitch_penalty(theme_mel, mel)
        kt = _mda_temporal_penalty(theme_mel, mel, bpb)
        kh = _mda_harmonic_penalty(notes, s_theme, e_theme, s_beat, e_beat)
        k  = (3.5*kp + 5*kt + 1.5*kh) / 10
        alpha = math.degrees(math.atan((1-k)/k)) if k > 0 else 90.0
        segments_out.append({
            "label":      lbl,
            "kp":         round(kp, 4),
            "kt":         round(kt, 4),
            "kh":         round(kh, 4),
            "k":          round(k,  4),
            "alpha":      round(alpha, 2),
            "band":       _mda_similarity_band(k),
            "type":       _mda_var_type(kp, kt, kh),
            "melody_len": len(mel),
        })

    return {
        "matched":    True,
        "midi_file":  midi_path.name,
        "bpb":        bpb,
        "n_segments": n_segs,
        "segments":   segments_out,
    }


@app.get("/api/midi/mda/{file_name}")
def get_mda_analysis(file_name: str, n_variations: int | None = None):
    """MDA penalty analysis (Almada 2023 §3.5): kp, kt, kh, k, band, type per variation."""
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {"matched": False, "message": f"No MIDI found for '{file_name}'"}
    result = _compute_mda_analysis(midi_path, n_variations=n_variations)
    result["file_name"] = file_name
    return result


# ── Chord Degree Distribution (Circos harmony view) ──────────────────────────
#
#   GET /api/midi/chord_degrees/{file_name}?n_variations=N
#
#   Returns per-segment scale-degree distributions for the Circos visualization.
#   For each segment:
#     - detected key (root 0-11, mode "major"/"minor", readable name)
#     - 7-element degree proportions [I, II, III, IV, V, VI, VII]
#       weighted by note duration within the segment
#
#   Chromatic notes are assigned to the nearest diatonic scale degree so every
#   note contributes, preserving the "dominant red / tonic blue" contrast
#   observed by Schroer (Kelly Schroer, 2019) and cited by Miller et al. 2019.
# ─────────────────────────────────────────────────────────────────────────────

# Semitone intervals of each diatonic degree from root, for major and minor
_DEGREE_SEMITONES = {
    "major": [0, 2, 4, 5, 7, 9, 11],   # I II III IV V VI VII
    "minor": [0, 2, 3, 5, 7, 8, 10],   # I II III IV V VI VII
}
_NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]


def _pc_to_degree(pc: int, root: int, mode: str) -> int:
    """Map a pitch class (0-11) to the nearest diatonic degree index (0=I … 6=VII)."""
    semitones = _DEGREE_SEMITONES[mode]
    rel = (pc - root) % 12
    best_idx, best_dist = 0, 12
    for i, s in enumerate(semitones):
        d = min(abs(rel - s), 12 - abs(rel - s))
        if d < best_dist:
            best_dist, best_idx = d, i
    return best_idx


@app.get("/api/midi/chord_degrees/{file_name}")
def get_chord_degrees(file_name: str, n_variations: int | None = None):
    """
    Per-segment scale-degree distribution for Circos-style harmony visualization.
    Degree V (Dominant) is highlighted analogously to Schroer (2019) / Miller et al. (2019).
    """
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {"matched": False, "message": f"No MIDI found for '{file_name}'"}

    if mido is None:
        raise HTTPException(500, "mido not installed")

    mid   = mido.MidiFile(str(midi_path))
    tpb   = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    # ── build note list (pitch + beat + duration) ─────────────────────
    on: dict[int, tuple[int,int]] = {}   # pitch → (abs_tick, channel)
    abs_t = 0
    notes: list[dict] = []
    for msg in merged:
        abs_t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            on[msg.note] = (abs_t, msg.channel)
        elif msg.type in ("note_off", "note_on") and msg.note in on:
            on_t, _ = on.pop(msg.note)
            dur = max(0.01, (abs_t - on_t) / tpb)
            notes.append({"pitch": msg.note, "beat": on_t / tpb, "dur": dur})

    if not notes:
        return {"matched": False, "message": "No notes found"}

    notes.sort(key=lambda n: n["beat"])
    total_bars = int(max(n["beat"] for n in notes) / 4) + 1

    # ── segment boundaries (mirrors _parse_midi_analysis strategy) ────
    bpb = 4
    seg_labels: list[str] = []
    seg_starts: list[int] = []   # in bars

    if n_variations is not None and n_variations >= 1:
        n_segs = n_variations + 1
        step   = total_bars / n_segs
        seg_starts = [round(i * step) for i in range(n_segs)]
        seg_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_variations + 1)]

    if not seg_labels:
        # annotation lookup
        k_num = _extract_k_number(midi_path.name)
        qn    = _extract_catalog_numbers(midi_path.stem)
        if k_num and ANNOTATION.exists():
            try:
                ann  = pd.read_excel(ANNOTATION)
                pat  = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
                rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
                if not rows.empty:
                    row       = rows.iloc[0]
                    raw       = str(row.get("label", "")).strip().strip("[]").replace("'","").replace('"',"")
                    lbls_raw  = [s.strip() for s in raw.split(",") if s.strip()]
                    n_segs    = len(lbls_raw)
                    step      = total_bars / n_segs
                    seg_starts = [round(i * step) for i in range(n_segs)]
                    seg_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_segs)]
                    seg_labels = seg_labels[:n_segs]
            except Exception:
                pass

    if not seg_labels:
        # fallback: 16-bar segments
        step = 16
        n_segs = max(1, total_bars // step)
        seg_starts = [i * step for i in range(n_segs)]
        seg_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_segs)]

    seg_starts.append(total_bars)   # sentinel end

    # ── KS key detection (reuse same Temperley profiles) ──────────────
    def detect_key(seg_notes: list[dict]):
        pc = [0.0] * 12
        for n in seg_notes:
            pc[n["pitch"] % 12] += n["dur"]
        s = sum(pc) or 1
        pc = [v / s for v in pc]
        mu_c = sum(pc) / 12
        ss_c = sum((x - mu_c) ** 2 for x in pc) or 1e-9
        best_r, best_root, best_mode = -999.0, 0, "major"
        for root in range(12):
            for mode, prof in (("major", KS_MAJ), ("minor", KS_MIN)):
                rot   = [prof[(j - root) % 12] for j in range(12)]
                mu_p  = sum(rot) / 12
                num   = sum((rot[j] - mu_p) * (pc[j] - mu_c) for j in range(12))
                den   = math.sqrt(sum((x - mu_p)**2 for x in rot) * ss_c)
                r     = num / den if den > 0 else 0.0
                if r > best_r:
                    best_r, best_root, best_mode = r, root, mode
        return best_root, best_mode

    # ── build per-segment output ───────────────────────────────────────
    segments_out = []
    for i, lbl in enumerate(seg_labels):
        s_beat = seg_starts[i]   * bpb
        e_beat = seg_starts[i+1] * bpb
        seg_notes = [n for n in notes if s_beat <= n["beat"] < e_beat]
        if not seg_notes:
            continue

        root, mode = detect_key(seg_notes)

        # Accumulate duration per diatonic degree (0=I … 6=VII)
        deg_dur = [0.0] * 7
        for n in seg_notes:
            d = _pc_to_degree(n["pitch"] % 12, root, mode)
            deg_dur[d] += n["dur"]

        total_dur = sum(deg_dur) or 1
        proportions = [round(v / total_dur, 4) for v in deg_dur]

        segments_out.append({
            "idx":         i,
            "label":       lbl,
            "key_root":    root,
            "key_mode":    mode,
            "key_name":    f"{_NOTE_NAMES[root]} {mode}",
            "proportions": proportions,  # [I, II, III, IV, V, VI, VII]
        })

    return {
        "matched":    True,
        "file_name":  file_name,
        "n_segments": len(segments_out),
        "segments":   segments_out,
    }


# ── T4 Theme Tracing ─────────────────────────────────────────────────────────
#
#   GET /api/midi/theme_trace/{file_name}?n_variations=N
#
#   Extract the theme's skeleton melody (highest-pitch note per 0.5-beat slot),
#   then fuzzy-match each skeleton note into every variation segment.
#
#   Matching score = pos_dist * 2  −  pc_match_bonus  +  octave_dist * 0.3
#   Confidence     = max(0, 1 − score)   (higher = better match)

@app.get("/api/midi/theme_trace/{file_name}")
def get_theme_trace(file_name: str, n_variations: int | None = None):
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {"matched": False, "message": f"No MIDI found for '{file_name}'"}
    if mido is None:
        raise HTTPException(500, "mido not installed")

    mid    = mido.MidiFile(str(midi_path))
    tpb    = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    # ── Build note list ────────────────────────────────────────────────
    on: dict[int, tuple[int, int]] = {}
    abs_t  = 0
    notes: list[dict] = []
    for msg in merged:
        abs_t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            on[msg.note] = (abs_t, msg.channel)
        elif msg.type in ("note_off", "note_on") and msg.note in on:
            on_t, _ = on.pop(msg.note)
            dur = max(0.01, (abs_t - on_t) / tpb)
            notes.append({"pitch": msg.note, "beat": on_t / tpb,
                          "vel": getattr(msg, "velocity", 64), "dur": dur})

    if not notes:
        return {"matched": False, "message": "No notes found"}

    notes.sort(key=lambda n: n["beat"])
    total_bars = int(max(n["beat"] for n in notes) / 4) + 1
    bpb        = 4

    # ── Segment boundaries (same 3-strategy logic as chord_degrees) ────
    seg_labels: list[str] = []
    seg_starts: list[int] = []   # in bars

    if n_variations is not None and n_variations >= 1:
        n_segs     = n_variations + 1
        step       = total_bars / n_segs
        seg_starts = [round(i * step) for i in range(n_segs)]
        seg_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_variations + 1)]

    if not seg_labels:
        k_num = _extract_k_number(midi_path.name)
        if k_num and ANNOTATION.exists():
            try:
                ann  = pd.read_excel(ANNOTATION)
                pat  = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
                rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
                if not rows.empty:
                    row      = rows.iloc[0]
                    raw      = str(row.get("label", "")).strip().strip("[]").replace("'","").replace('"',"")
                    lbls_raw = [s.strip() for s in raw.split(",") if s.strip()]
                    n_segs   = len(lbls_raw)
                    step     = total_bars / n_segs
                    seg_starts = [round(i * step) for i in range(n_segs)]
                    seg_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_segs)]
                    seg_labels = seg_labels[:n_segs]
            except Exception:
                pass

    if not seg_labels:
        step       = 16
        n_segs     = max(1, total_bars // step)
        seg_starts = [i * step for i in range(n_segs)]
        seg_labels = ["Theme"] + [f"Var.{i:02d}" for i in range(1, n_segs)]

    seg_starts.append(total_bars)  # sentinel end

    # ── Extract theme skeleton ─────────────────────────────────────────
    th_s = seg_starts[0] * bpb
    th_e = seg_starts[1] * bpb
    theme_notes = [n for n in notes if th_s <= n["beat"] < th_e]
    th_span     = (th_e - th_s) or 1

    # Highest-pitch note per 0.5-beat slot
    slots: dict[float, dict] = {}
    for n in theme_notes:
        slot = round((n["beat"] - th_s) / 0.5) * 0.5
        if slot not in slots or n["pitch"] > slots[slot]["pitch"]:
            slots[slot] = n

    skeleton_raw = sorted(slots.values(), key=lambda n: n["beat"])

    # Thin out: keep at most 1 note per beat (too many skeleton pts clutters the view)
    thinned: list[dict] = []
    last_beat = -999.0
    for sn in skeleton_raw:
        if (sn["beat"] - last_beat) >= 0.8:   # min 0.8 beats apart
            thinned.append(sn)
            last_beat = sn["beat"]

    theme_skeleton = [
        {
            "idx":         idx,
            "pitch":       sn["pitch"],
            "pitch_class": sn["pitch"] % 12,
            "rel_pos":     round((sn["beat"] - th_s) / th_span, 4),
            "beat":        round(sn["beat"], 3),
        }
        for idx, sn in enumerate(thinned)
    ]

    if not theme_skeleton:
        return {"matched": False, "message": "Theme skeleton empty"}

    # ── Match skeleton notes in each variation ─────────────────────────
    NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
    variations_out = []

    for i in range(1, len(seg_labels)):
        lbl    = seg_labels[i]
        s_beat = seg_starts[i]     * bpb
        e_beat = seg_starts[i + 1] * bpb
        v_span = (e_beat - s_beat) or 1
        var_notes = [n for n in notes if s_beat <= n["beat"] < e_beat]

        matches = []
        for sk in theme_skeleton:
            th_pos  = sk["rel_pos"]
            th_pc   = sk["pitch_class"]
            th_p    = sk["pitch"]

            best_n     = None
            best_score = float("inf")

            for vn in var_notes:
                vn_pos   = (vn["beat"] - s_beat) / v_span
                pos_dist = abs(vn_pos - th_pos)
                if pos_dist > 0.28:
                    continue                              # outside search window

                pc_match  = (vn["pitch"] % 12) == th_pc
                oct_dist  = abs(vn["pitch"] - th_p) / 12
                score     = pos_dist * 2.0 - (0.8 if pc_match else 0.0) + oct_dist * 0.3

                if score < best_score:
                    best_score = score
                    best_n     = vn
                    best_n_pos = vn_pos
                    best_pc    = pc_match

            if best_n is not None:
                conf = round(max(0.0, 1.0 - min(best_score, 1.0)), 3)
                matches.append({
                    "theme_note_idx": sk["idx"],
                    "var_pitch":      best_n["pitch"],
                    "var_pos":        round(best_n_pos, 4),
                    "pc_match":       best_pc,
                    "confidence":     conf,
                    "note_name":      NOTE_NAMES[best_n["pitch"] % 12],
                })

        variations_out.append({
            "seg_idx": i,
            "label":   lbl,
            "matches": matches,
        })

    return {
        "matched":        True,
        "file_name":      file_name,
        "n_segments":     len(seg_labels),
        "theme_skeleton": theme_skeleton,
        "variations":     variations_out,
    }


# ── Interval Fingerprint ─────────────────────────────────────────────────────
#
#   GET /api/midi/intervals/{file_name}
#
#   Extracts the melodic interval distribution from a MIDI file.
#   Processes each MIDI track independently; consecutive notes in the same
#   track with different onset ticks form melodic intervals.  Simultaneous
#   notes (same onset tick) are treated as chord tones and skipped so we
#   measure horizontal (melodic) motion, not vertical (harmonic) intervals.
#
#   Returns:
#     matched        – bool
#     total_intervals – int
#     intervals      – list of {semitones, name, count, pct, up, down}
#                      semitones 0-12; index 13 = ">8ve"
# ─────────────────────────────────────────────────────────────────────────────

INTERVAL_NAMES = [
    "U",   # 0  unison / repeated note
    "m2",  # 1  minor second
    "M2",  # 2  major second
    "m3",  # 3  minor third
    "M3",  # 4  major third
    "P4",  # 5  perfect fourth
    "TT",  # 6  tritone
    "P5",  # 7  perfect fifth
    "m6",  # 8  minor sixth
    "M6",  # 9  major sixth
    "m7",  # 10 minor seventh
    "M7",  # 11 major seventh
    "P8",  # 12 octave
    ">8",  # 13 larger than octave
]

@app.get("/api/midi/intervals/{file_name}")
def get_midi_intervals(file_name: str):
    """
    Return melodic interval distribution for the given piece's MIDI file.
    Processes per-track note sequences; skips chord (simultaneous) notes.
    """
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {
            "matched":   False,
            "file_name": file_name,
            "message":   f"No matching MIDI found for '{file_name}' in TV_MIDI/",
        }
    if mido is None:
        raise HTTPException(500, "mido not installed. Run: pip install mido")

    mid = mido.MidiFile(str(midi_path))

    counts_abs  = [0] * 14   # index = semitones (0-12 + 13 for >8ve)
    counts_up   = [0] * 14   # ascending moves
    counts_down = [0] * 14   # descending moves

    for track in mid.tracks:
        abs_t = 0
        # Collect (onset_tick, pitch) pairs
        track_notes: list[tuple[int, int]] = []
        active: dict[int, int] = {}  # pitch → onset_tick

        for msg in track:
            abs_t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                active[msg.note] = abs_t
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                if msg.note in active:
                    on_t = active.pop(msg.note)
                    track_notes.append((on_t, msg.note))

        if len(track_notes) < 2:
            continue

        track_notes.sort(key=lambda x: x[0])

        prev_tick, prev_pitch = track_notes[0]
        for tick, pitch in track_notes[1:]:
            if tick == prev_tick:
                # Same onset = chord; only advance prev_pitch if this note
                # is higher (track top voice of chord)
                if pitch > prev_pitch:
                    prev_pitch = pitch
                continue

            diff     = pitch - prev_pitch
            abs_diff = abs(diff)
            idx      = min(abs_diff, 13)

            counts_abs[idx] += 1
            if diff > 0:
                counts_up[idx] += 1
            elif diff < 0:
                counts_down[idx] += 1

            prev_tick, prev_pitch = tick, pitch

    total = sum(counts_abs)
    return {
        "matched":         True,
        "file_name":       file_name,
        "midi_name":       midi_path.name,
        "total_intervals": total,
        "intervals": [
            {
                "semitones": i,
                "name":      INTERVAL_NAMES[i],
                "count":     counts_abs[i],
                "pct":       round(counts_abs[i] / total, 4) if total > 0 else 0,
                "up":        counts_up[i],
                "down":      counts_down[i],
            }
            for i in range(14)
        ],
    }


# ── Chromaticism Map ─────────────────────────────────────────────────────────
#
#   GET /api/midi/chromaticism/{file_name}?n_variations=N
#
#   Divides the MIDI into Theme + Variations (same equal-bar strategy as the
#   main MIDI analysis), then for each section:
#     1. Detects the local key via Krumhansl-Schmuckler correlation.
#     2. Counts notes that fall OUTSIDE the diatonic scale of that key
#        (natural major or union of natural/harmonic/melodic minor).
#     3. Returns chromaticism % per section + most-common chromatic PCs.
#
#   Using per-section key detection (not global) correctly handles pieces like
#   Beethoven Op.34 where each variation is in a different key.
# ─────────────────────────────────────────────────────────────────────────────

# Diatonic pitch-class sets (relative to tonic = 0)
_DIATONIC_MAJOR = {0, 2, 4, 5, 7, 9, 11}
# Union of natural + harmonic + melodic minor to avoid marking leading
# tones or raised 6th/7th as "chromatic" in minor sections
_DIATONIC_MINOR = {0, 2, 3, 5, 7, 8, 9, 10, 11}

NOTE_NAMES_SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
NOTE_NAMES_FLAT  = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"]

# Use flat spelling for keys with flats (F, Bb, Eb, Ab, Db, Gb majors)
_FLAT_ROOTS = {5, 10, 3, 8, 1, 6}

def _pc_name(pc: int, root: int) -> str:
    return NOTE_NAMES_FLAT[pc] if root in _FLAT_ROOTS else NOTE_NAMES_SHARP[pc]

def _ks_detect(notes_in_seg: list[dict]) -> tuple[int, str]:
    """Return (root 0-11, 'major'|'minor') for a list of note dicts."""
    _KS_MAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]
    _KS_MIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]
    pc_raw = [0.0] * 12
    for n in notes_in_seg:
        pc_raw[n["pitch"] % 12] += 1
    s = sum(pc_raw) or 1
    pc = [v / s for v in pc_raw]
    mu_c = sum(pc) / 12
    ss_c = sum((x - mu_c) ** 2 for x in pc) or 1e-9
    best_r, best_root, best_mode = -999.0, 0, "major"
    for root in range(12):
        for mode, prof in (("major", _KS_MAJ), ("minor", _KS_MIN)):
            rot  = [prof[(j - root) % 12] for j in range(12)]
            mu_p = sum(rot) / 12
            num  = sum((rot[j] - mu_p) * (pc[j] - mu_c) for j in range(12))
            den  = math.sqrt(sum((x - mu_p)**2 for x in rot) * ss_c)
            r    = num / den if den > 0 else 0.0
            if r > best_r:
                best_r, best_root, best_mode = r, root, mode
    return best_root, best_mode


@app.get("/api/midi/chromaticism/{file_name}")
def get_midi_chromaticism(file_name: str, n_variations: int | None = None):
    """
    Per-section chromaticism analysis from MIDI.
    Returns the proportion of non-diatonic notes in each variation section,
    with per-section key detection via Krumhansl-Schmuckler.
    """
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {
            "matched":   False,
            "file_name": file_name,
            "message":   f"No matching MIDI found for '{file_name}' in TV_MIDI/",
        }
    if mido is None:
        raise HTTPException(500, "mido not installed")

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
                notes.append({
                    "pitch":    msg.note,
                    "velocity": vel,
                    "beat":     on_t / tpb,
                    "dur_sec":  max(0.01, tick2sec(abs_t) - tick2sec(on_t)),
                })

    if not notes:
        return {"matched": False, "file_name": file_name, "message": "No notes found"}

    notes.sort(key=lambda n: n["beat"])

    def note_bar(n: dict) -> int:
        return int(n["beat"] / beats_per_bar)

    total_bars = max(note_bar(n) for n in notes) + 1

    # ── Section boundaries (same strategy as _parse_midi_analysis) ──
    var_labels: list[str] = []
    var_starts: list[int] = []

    if n_variations is not None and n_variations >= 1:
        n_segs = n_variations + 1
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, n_variations + 1)]

    k_num = _extract_k_number(midi_path.name)
    if not var_labels and k_num and ANNOTATION.exists():
        try:
            ann = pd.read_excel(ANNOTATION)
            pat = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
            rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
            if not rows.empty:
                row = rows.iloc[0]
                raw = str(row.get("label", "")).strip().strip("[]").replace("'","").replace('"',"")
                seg_labels_raw = [s.strip() for s in raw.split(",") if s.strip()]
                if len(seg_labels_raw) >= 2:
                    step = total_bars / len(seg_labels_raw)
                    var_starts = [round(i * step) for i in range(len(seg_labels_raw))]
                    var_labels = seg_labels_raw
        except Exception:
            pass

    if not var_labels:
        n_segs = 13
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, 13)]

    var_ends = var_starts[1:] + [total_bars]

    def notes_in(s: int, e: int) -> list[dict]:
        return [n for n in notes if s <= note_bar(n) < e]

    # ── Helper: bar index → approximate audio time (seconds) ──
    def bar_to_sec(bar: int) -> float:
        tick = int(bar * beats_per_bar * tpb)
        return round(tick2sec(tick), 3)

    # ── Per-section chromaticism ──
    sections = []
    for lbl, s, e in zip(var_labels, var_starts, var_ends):
        nl = notes_in(s, e)
        if not nl:
            sections.append({
                "label": lbl, "total": 0,
                "bar_start": s, "bar_end": e,
                "time_sec": bar_to_sec(s),
                "diatonic": 0, "chromatic": 0, "chromatic_pct": 0.0,
                "key_name": "?", "key_root": 0, "is_major": True,
                "top_chromatic_pcs": [],
            })
            continue

        root, mode = _ks_detect(nl)
        is_major   = mode == "major"
        diatonic_pcs = (
            {(root + d) % 12 for d in _DIATONIC_MAJOR}
            if is_major else
            {(root + d) % 12 for d in _DIATONIC_MINOR}
        )

        chromatic_count: dict[int, int] = {}
        diatonic_n = 0
        for n in nl:
            pc = n["pitch"] % 12
            if pc in diatonic_pcs:
                diatonic_n += 1
            else:
                chromatic_count[pc] = chromatic_count.get(pc, 0) + 1

        total_n = len(nl)
        chrom_n = total_n - diatonic_n
        top_chrom = sorted(chromatic_count.items(), key=lambda x: -x[1])[:5]

        mode_str = "maj" if is_major else "min"
        key_name = f"{_pc_name(root, root)} {mode_str}"

        sections.append({
            "label":       lbl,
            "total":       total_n,
            "bar_start":   s,
            "bar_end":     e,
            "time_sec":    bar_to_sec(s),
            "diatonic":    diatonic_n,
            "chromatic":   chrom_n,
            "chromatic_pct": round(chrom_n / total_n, 4) if total_n else 0.0,
            "key_name":    key_name,
            "key_root":    root,
            "is_major":    is_major,
            "top_chromatic_pcs": [
                {"pc": pc, "name": _pc_name(pc, root), "count": cnt}
                for pc, cnt in top_chrom
            ],
        })

    return {
        "matched":    True,
        "file_name":  file_name,
        "midi_name":  midi_path.name,
        "sections":   sections,
    }


# ──────────────────────────────────────────────────────────────
#  Rhythmic Density Profile
# ──────────────────────────────────────────────────────────────

@app.get("/api/midi/rhythm_density/{file_name}")
def get_midi_rhythm_density(file_name: str, n_variations: int | None = None):
    """
    Per-section rhythmic density from MIDI.
    Classifies note durations into categories (whole/half/quarter/eighth/sixteenth/shorter)
    and returns their proportion per variation section.
    """
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {
            "matched":   False,
            "file_name": file_name,
            "message":   f"No matching MIDI found for '{file_name}' in TV_MIDI/",
        }
    if mido is None:
        raise HTTPException(500, "mido not installed")

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

    def tick2beat(tick: int) -> float:
        return tick / tpb

    # ── Collect notes with duration in beats ──
    notes: list[dict] = []
    active: dict = {}
    abs_t = 0
    beats_per_bar = 4

    for msg in merged:
        abs_t += msg.time
        if msg.type == "time_signature":
            beats_per_bar = msg.numerator
        if msg.type == "note_on" and msg.velocity > 0:
            active[(msg.note, msg.channel)] = abs_t
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            key = (msg.note, msg.channel)
            if key in active:
                on_t = active.pop(key)
                dur_beats = tick2beat(abs_t - on_t)
                beat_on   = tick2beat(on_t)
                notes.append({
                    "pitch":    msg.note,
                    "beat":     beat_on,
                    "dur":      max(0.01, dur_beats),
                })

    if not notes:
        return {"matched": False, "file_name": file_name, "message": "No notes found"}

    notes.sort(key=lambda n: n["beat"])

    def note_bar(n: dict) -> int:
        return int(n["beat"] / beats_per_bar)

    total_bars = max(note_bar(n) for n in notes) + 1

    # ── Section boundaries ──
    var_labels: list[str] = []
    var_starts: list[int] = []

    if n_variations is not None and n_variations >= 1:
        n_segs = n_variations + 1
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, n_variations + 1)]

    k_num = _extract_k_number(midi_path.name)
    if not var_labels and k_num and ANNOTATION.exists():
        try:
            ann = pd.read_excel(ANNOTATION)
            pat = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
            rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
            if not rows.empty:
                row = rows.iloc[0]
                raw = str(row.get("label", "")).strip().strip("[]").replace("'","").replace('"',"")
                seg_labels_raw = [s.strip() for s in raw.split(",") if s.strip()]
                if len(seg_labels_raw) >= 2:
                    step = total_bars / len(seg_labels_raw)
                    var_starts = [round(i * step) for i in range(len(seg_labels_raw))]
                    var_labels = seg_labels_raw
        except Exception:
            pass

    if not var_labels:
        n_segs = 13
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, 13)]

    var_ends = var_starts[1:] + [total_bars]

    CATEGORIES = ["whole", "half", "quarter", "eighth", "sixteenth", "shorter"]

    def classify_dur(d: float) -> str:
        if d >= 3.5:   return "whole"
        if d >= 1.5:   return "half"
        if d >= 0.75:  return "quarter"
        if d >= 0.375: return "eighth"
        if d >= 0.18:  return "sixteenth"
        return "shorter"

    def notes_in(s: int, e: int) -> list[dict]:
        return [n for n in notes if s <= note_bar(n) < e]

    sections = []
    for lbl, s, e in zip(var_labels, var_starts, var_ends):
        nl = notes_in(s, e)
        counts = {c: 0 for c in CATEGORIES}
        for n in nl:
            counts[classify_dur(n["dur"])] += 1
        total = len(nl)
        proportions = {c: round(counts[c] / total, 4) if total else 0.0 for c in CATEGORIES}
        sections.append({
            "label":       lbl,
            "total":       total,
            "counts":      counts,
            "proportions": proportions,
        })

    return {
        "matched":    True,
        "file_name":  file_name,
        "midi_name":  midi_path.name,
        "categories": CATEGORIES,
        "sections":   sections,
    }


# ──────────────────────────────────────────────────────────────
#  Chord Palette
# ──────────────────────────────────────────────────────────────

def _classify_chord(pcs: set[int]) -> str:
    """
    Given a set of pitch-classes, return a chord type label.
    Tries all 12 roots for each pattern.
    """
    if len(pcs) < 2:
        return "single"

    # Interval sets relative to root (sorted intervals from root)
    patterns: list[tuple[str, set]] = [
        ("major",    {0, 4, 7}),
        ("minor",    {0, 3, 7}),
        ("dim",      {0, 3, 6}),
        ("aug",      {0, 4, 8}),
        ("sus2",     {0, 2, 7}),
        ("sus4",     {0, 5, 7}),
        ("dom7",     {0, 4, 7, 10}),
        ("maj7",     {0, 4, 7, 11}),
        ("min7",     {0, 3, 7, 10}),
        ("dim7",     {0, 3, 6, 9}),
        ("halfdim7", {0, 3, 6, 10}),
        ("augmaj7",  {0, 4, 8, 11}),
    ]

    for root in range(12):
        normalized = {(pc - root) % 12 for pc in pcs}
        for name, pat in patterns:
            # Pattern must be a subset of or equal to normalized (allow added notes)
            if pat.issubset(normalized) or normalized == pat:
                return name

    # Dyad fallback: interval
    if len(pcs) == 2:
        interval = min((b - a) % 12 for a in pcs for b in pcs if b != a)
        if interval in (3, 4):   return "third"
        if interval in (5, 7):   return "fifth"
        return "dyad"

    return "other"


@app.get("/api/midi/chord_palette/{file_name}")
def get_midi_chord_palette(file_name: str, n_variations: int | None = None):
    """
    Per-section chord type distribution from MIDI.
    Groups simultaneously sounding notes by onset tick,
    identifies chord types, and returns proportions per variation section.
    """
    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {
            "matched":   False,
            "file_name": file_name,
            "message":   f"No matching MIDI found for '{file_name}' in TV_MIDI/",
        }
    if mido is None:
        raise HTTPException(500, "mido not installed")

    mid = mido.MidiFile(str(midi_path))
    tpb = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    # ── Collect note-on events grouped by tick ──
    onsets: dict[int, list[int]] = {}   # tick → [pitches]
    abs_t = 0
    beats_per_bar = 4

    for msg in merged:
        abs_t += msg.time
        if msg.type == "time_signature":
            beats_per_bar = msg.numerator
        if msg.type == "note_on" and msg.velocity > 0:
            onsets.setdefault(abs_t, []).append(msg.note)

    if not onsets:
        return {"matched": False, "file_name": file_name, "message": "No notes found"}

    # Build chord events: (beat, chord_type)
    chord_events: list[dict] = []
    for tick in sorted(onsets):
        pitches = onsets[tick]
        pcs     = {p % 12 for p in pitches}
        ctype   = _classify_chord(pcs)
        beat    = tick / tpb
        chord_events.append({"beat": beat, "type": ctype, "n_notes": len(pitches)})

    total_beats = max(e["beat"] for e in chord_events)
    beats_total = total_beats + beats_per_bar

    def event_bar(e: dict) -> int:
        return int(e["beat"] / beats_per_bar)

    total_bars = max(event_bar(e) for e in chord_events) + 1

    # ── Section boundaries ──
    var_labels: list[str] = []
    var_starts: list[int] = []

    if n_variations is not None and n_variations >= 1:
        n_segs = n_variations + 1
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, n_variations + 1)]

    k_num = _extract_k_number(midi_path.name)
    if not var_labels and k_num and ANNOTATION.exists():
        try:
            ann = pd.read_excel(ANNOTATION)
            pat = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
            rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
            if not rows.empty:
                row = rows.iloc[0]
                raw = str(row.get("label", "")).strip().strip("[]").replace("'","").replace('"',"")
                seg_labels_raw = [s.strip() for s in raw.split(",") if s.strip()]
                if len(seg_labels_raw) >= 2:
                    step = total_bars / len(seg_labels_raw)
                    var_starts = [round(i * step) for i in range(len(seg_labels_raw))]
                    var_labels = seg_labels_raw
        except Exception:
            pass

    if not var_labels:
        n_segs = 13
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, 13)]

    var_ends = var_starts[1:] + [total_bars]

    CHORD_TYPES = ["major", "minor", "dom7", "maj7", "min7", "dim", "dim7",
                   "halfdim7", "aug", "augmaj7", "sus2", "sus4",
                   "third", "fifth", "dyad", "single", "other"]

    def events_in(s: int, e: int) -> list[dict]:
        return [ev for ev in chord_events if s <= event_bar(ev) < e]

    sections = []
    for lbl, s, e in zip(var_labels, var_starts, var_ends):
        evs   = events_in(s, e)
        total = len(evs)
        counts = {ct: 0 for ct in CHORD_TYPES}
        for ev in evs:
            counts[ev["type"]] = counts.get(ev["type"], 0) + 1
        proportions = {ct: round(counts[ct] / total, 4) if total else 0.0
                       for ct in CHORD_TYPES}
        # Top 5 chord types
        top = sorted(counts.items(), key=lambda x: -x[1])
        top5 = [{"type": ct, "count": cnt, "pct": round(cnt/total, 4) if total else 0.0}
                for ct, cnt in top if cnt > 0][:5]
        sections.append({
            "label":       lbl,
            "total":       total,
            "counts":      counts,
            "proportions": proportions,
            "top":         top5,
        })

    return {
        "matched":     True,
        "file_name":   file_name,
        "midi_name":   midi_path.name,
        "chord_types": CHORD_TYPES,
        "sections":    sections,
    }


# ──────────────────────────────────────────────────────────────
#  Rubato Curve  (/api/rubato/{file_name})
# ──────────────────────────────────────────────────────────────

def _find_audio_file(file_name: str) -> "Path | None":
    """Search TV_dataset_audio/ subdirs for <file_name>.wav"""
    if not AUDIO_DIR.exists():
        return None
    direct = AUDIO_DIR / f"{file_name}.wav"
    if direct.exists():
        return direct
    for d in AUDIO_DIR.iterdir():
        if d.is_dir():
            p = d / f"{file_name}.wav"
            if p.exists():
                return p
    return None


@app.get("/api/rubato/{file_name}")
def get_rubato(file_name: str, n_variations: int | None = None):
    """
    Rubato (expressive timing deviation) curve.

    Method
    ------
    1. Parse MIDI tempo map → theoretical beat times T_midi[b] (seconds).
    2. Load audio with librosa → detect actual beat times T_audio[b].
    3. Align MIDI beats to audio beats via nearest-neighbour matching
       (no DTW needed: both sequences are sorted and usually close).
    4. deviation[b] = (T_audio_matched[b] - T_midi[b]) * 1000  [ms]
       Positive → performer slows down (rubato / delay)
       Negative → performer rushes ahead

    Returns per-beat deviation together with section labels so the
    frontend can colour-code each variation section.
    """
    if librosa is None or np is None:
        raise HTTPException(500, "librosa / numpy not installed in backend")
    if mido is None:
        raise HTTPException(500, "mido not installed")

    # ── Locate files ──────────────────────────────────────────
    midi_path  = _find_midi_file(file_name)
    audio_path = _find_audio_file(file_name)

    if midi_path is None:
        return {"matched": False, "file_name": file_name,
                "message": f"No MIDI found for '{file_name}' in TV_MIDI/"}
    if audio_path is None:
        return {"matched": False, "file_name": file_name,
                "message": f"No audio found for '{file_name}' in TV_dataset_audio/"}

    # ── Parse MIDI → theoretical beat grid ────────────────────
    mid    = mido.MidiFile(str(midi_path))
    tpb    = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    tempo_map: list[tuple[int, int]] = [(0, 500_000)]
    beats_per_bar = 4
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "set_tempo":
            tempo_map.append((abs_t, msg.tempo))
        if msg.type == "time_signature":
            beats_per_bar = msg.numerator

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

    # Scan MIDI for the last note-off tick to determine total length
    last_tick = 0
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type in ("note_on", "note_off"):
            last_tick = max(last_tick, abs_t)

    total_beats_midi = int(last_tick / tpb) + 1

    # Build theoretical beat time array (seconds)
    midi_beat_times = np.array([tick2sec(b * tpb) for b in range(total_beats_midi)])

    # ── Load audio → actual beat times ────────────────────────
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        # Use beat tracker for stable global tempo tracking
        _, audio_beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
        audio_beat_times = librosa.frames_to_time(audio_beat_frames, sr=sr)
    except Exception as exc:
        return {"matched": False, "file_name": file_name,
                "message": f"Audio analysis failed: {exc}"}

    # ── Nearest-neighbour alignment ────────────────────────────
    # For each MIDI beat, find the closest audio beat time.
    # We discard beats beyond the audio duration.
    audio_dur = len(y) / sr
    beats: list[dict] = []

    for b, t_midi in enumerate(midi_beat_times):
        if t_midi > audio_dur:
            break
        # Find nearest audio beat
        idx = int(np.argmin(np.abs(audio_beat_times - t_midi)))
        t_audio = float(audio_beat_times[idx])
        dev_ms  = round((t_audio - t_midi) * 1000.0, 1)   # ms; +→rubato, -→rush
        beats.append({
            "beat":    b,
            "bar":     b // beats_per_bar,
            "t_midi":  round(float(t_midi), 3),
            "t_audio": round(t_audio, 3),
            "dev_ms":  dev_ms,
        })

    if not beats:
        return {"matched": False, "file_name": file_name,
                "message": "Alignment produced no beats"}

    total_bars = beats[-1]["bar"] + 1

    # ── Section boundaries ─────────────────────────────────────
    var_labels: list[str] = []
    var_starts: list[int] = []

    if n_variations is not None and n_variations >= 1:
        n_segs = n_variations + 1
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, n_variations + 1)]

    k_num = _extract_k_number(midi_path.name)
    if not var_labels and k_num and ANNOTATION.exists():
        try:
            ann = pd.read_excel(ANNOTATION)
            pat = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
            rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
            if not rows.empty:
                row = rows.iloc[0]
                raw = str(row.get("label", "")).strip().strip("[]").replace("'","").replace('"',"")
                seg_labels_raw = [s.strip() for s in raw.split(",") if s.strip()]
                if len(seg_labels_raw) >= 2:
                    step = total_bars / len(seg_labels_raw)
                    var_starts = [round(i * step) for i in range(len(seg_labels_raw))]
                    var_labels = seg_labels_raw
        except Exception:
            pass

    if not var_labels:
        n_segs = 13
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, 13)]

    var_ends = var_starts[1:] + [total_bars]

    # Attach section label to each beat
    bar_to_label = {}
    for lbl, s, e in zip(var_labels, var_starts, var_ends):
        for bar in range(s, e):
            bar_to_label[bar] = lbl

    for bt in beats:
        bt["section"] = bar_to_label.get(bt["bar"], "?")

    # ── Per-section summary stats ──────────────────────────────
    from statistics import mean, stdev
    sections = []
    for lbl, s, e in zip(var_labels, var_starts, var_ends):
        seg_devs = [bt["dev_ms"] for bt in beats if s <= bt["bar"] < e]
        if not seg_devs:
            continue
        sections.append({
            "label":    lbl,
            "bar_start": s,
            "bar_end":   e,
            "mean_dev":  round(mean(seg_devs), 1),
            "std_dev":   round(stdev(seg_devs) if len(seg_devs) > 1 else 0.0, 1),
            "max_dev":   round(max(seg_devs), 1),
            "min_dev":   round(min(seg_devs), 1),
        })

    return {
        "matched":    True,
        "file_name":  file_name,
        "midi_name":  midi_path.name,
        "audio_name": audio_path.name,
        "beats":      beats,
        "sections":   sections,
        "var_labels": var_labels,
    }


# ──────────────────────────────────────────────────────────────
#  Harmonic Tension × Ornament Density
#  GET /api/midi/tension_ornament/{file_name}
# ──────────────────────────────────────────────────────────────

# Interval dissonance weights (semitones 0–11, wrap at octave)
# Based on Huron (1994) / Parncutt roughness model (simplified).
_INTERVAL_TENSION = {
    0:  0.00,   # unison / octave
    1:  0.90,   # minor 2nd
    2:  0.65,   # major 2nd
    3:  0.15,   # minor 3rd
    4:  0.10,   # major 3rd
    5:  0.05,   # perfect 4th
    6:  0.85,   # tritone
    7:  0.00,   # perfect 5th
    8:  0.15,   # minor 6th
    9:  0.10,   # major 6th
    10: 0.60,   # minor 7th
    11: 0.80,   # major 7th
}


def _chord_tension(pitches: list[int]) -> float:
    """
    Mean pairwise interval dissonance for a set of pitches.
    Returns a value in [0, 1].
    """
    pcs = list({p % 12 for p in pitches})
    if len(pcs) < 2:
        return 0.0
    total, count = 0.0, 0
    for i in range(len(pcs)):
        for j in range(i + 1, len(pcs)):
            iv = min((pcs[j] - pcs[i]) % 12, (pcs[i] - pcs[j]) % 12)
            total += _INTERVAL_TENSION.get(iv, 0.5)
            count += 1
    return round(total / count, 4) if count else 0.0


@app.get("/api/midi/tension_ornament/{file_name}")
def get_tension_ornament(file_name: str, n_variations: int | None = None):
    """
    Per-bar harmonic tension + ornament density from MIDI.

    Tension (0–1):
      For each bar, collect all simultaneously active pitches in a
      rolling 0.25-beat window, compute mean pairwise interval
      dissonance (Huron roughness model), average over the bar.

    Ornament density (count per bar):
      A note is "ornament-like" when its duration < ORNAMENT_THRESH
      beats (typically trills, mordents, grace notes in MIDI).
      Count such notes per bar.
    """
    if mido is None:
        raise HTTPException(500, "mido not installed")

    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {"matched": False, "file_name": file_name,
                "message": f"No MIDI found for '{file_name}' in TV_MIDI/"}

    mid    = mido.MidiFile(str(midi_path))
    tpb    = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    # ── Tempo map ──────────────────────────────────────────────
    tempo_map: list[tuple[int, int]] = [(0, 500_000)]
    beats_per_bar = 4
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "set_tempo":
            tempo_map.append((abs_t, msg.tempo))
        if msg.type == "time_signature":
            beats_per_bar = msg.numerator

    # ── Collect note events (onset_tick, pitch, dur_beats) ────
    active: dict[tuple[int,int], int] = {}   # (pitch, ch) → onset_tick
    note_events: list[tuple[int, int, float]] = []  # (onset_tick, pitch, dur_beats)
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            active[(msg.note, msg.channel)] = abs_t
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            key = (msg.note, msg.channel)
            if key in active:
                on_t = active.pop(key)
                dur_beats = (abs_t - on_t) / tpb
                note_events.append((on_t, msg.note, dur_beats))

    if not note_events:
        return {"matched": False, "file_name": file_name, "message": "No notes found"}

    last_tick   = max(e[0] for e in note_events)
    total_bars  = int(last_tick / tpb / beats_per_bar) + 1

    # ── Ornament threshold: < 0.25 beats ──────────────────────
    ORNAMENT_THRESH = 0.25   # beats

    # ── Per-bar aggregation ───────────────────────────────────
    # Group notes by bar
    bar_notes: dict[int, list[tuple[int, float]]] = {}   # bar → [(pitch, dur_beats)]
    for on_t, pitch, dur in note_events:
        bar = int(on_t / tpb / beats_per_bar)
        bar_notes.setdefault(bar, []).append((pitch, dur))

    bars_data: list[dict] = []
    for bar in range(total_bars):
        notes = bar_notes.get(bar, [])

        # ── Tension: sliding 0.25-beat window inside the bar ──
        # Group by quantised slot (0.25 beat = tpb/4 ticks)
        slot_pitches: dict[int, list[int]] = {}
        for on_t, pitch, dur in note_events:
            b = int(on_t / tpb / beats_per_bar)
            if b != bar:
                continue
            beat_in_bar = (on_t / tpb) % beats_per_bar
            slot = int(beat_in_bar / 0.25)
            slot_pitches.setdefault(slot, []).append(pitch)

        slot_tensions = [_chord_tension(ps) for ps in slot_pitches.values() if ps]
        tension = round(sum(slot_tensions) / len(slot_tensions), 4) if slot_tensions else 0.0

        # ── Ornament count: short-dur notes ───────────────────
        ornament_count = sum(1 for _, dur in notes if dur < ORNAMENT_THRESH and dur > 0)

        bars_data.append({
            "bar":           bar,
            "tension":       tension,
            "ornament_count": ornament_count,
        })

    # ── Section boundaries (reuse annotation logic) ────────────
    var_labels: list[str] = []
    var_starts: list[int] = []

    if n_variations is not None and n_variations >= 1:
        n_segs = n_variations + 1
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, n_variations + 1)]

    k_num = _extract_k_number(midi_path.name)
    if not var_labels and k_num and ANNOTATION.exists():
        try:
            ann = pd.read_excel(ANNOTATION)
            pat = re.compile(rf"[Kk][Vv]?\.?\s*{re.escape(k_num)}(?!\d)")
            rows = ann[ann["file_name (folderName_number)"].astype(str).str.contains(pat, regex=True)]
            if not rows.empty:
                row = rows.iloc[0]
                raw = str(row.get("label", "")).strip().strip("[]").replace("'","").replace('"',"")
                seg_labels_raw = [s.strip() for s in raw.split(",") if s.strip()]
                if len(seg_labels_raw) >= 2:
                    step = total_bars / len(seg_labels_raw)
                    var_starts = [round(i * step) for i in range(len(seg_labels_raw))]
                    var_labels = seg_labels_raw
        except Exception:
            pass

    if not var_labels:
        n_segs = 13
        step   = total_bars / n_segs
        var_starts = [round(i * step) for i in range(n_segs)]
        var_labels = ["T"] + [f"V{i}" for i in range(1, 13)]

    var_ends = var_starts[1:] + [total_bars]

    # Attach section label to each bar
    bar_to_label: dict[int, str] = {}
    for lbl, s, e in zip(var_labels, var_starts, var_ends):
        for b in range(s, e):
            bar_to_label[b] = lbl
    for bd in bars_data:
        bd["section"] = bar_to_label.get(bd["bar"], "?")

    # ── Per-section summary ────────────────────────────────────
    from statistics import mean
    sections_summary = []
    for lbl, s, e in zip(var_labels, var_starts, var_ends):
        seg = [bd for bd in bars_data if s <= bd["bar"] < e]
        if not seg:
            continue
        sections_summary.append({
            "label":          lbl,
            "bar_start":      s,
            "bar_end":        e,
            "mean_tension":   round(mean(bd["tension"] for bd in seg), 4),
            "max_tension":    round(max(bd["tension"] for bd in seg), 4),
            "total_ornaments": sum(bd["ornament_count"] for bd in seg),
        })

    # ── Normalise ornament_count for frontend ──────────────────
    max_orn = max((bd["ornament_count"] for bd in bars_data), default=1) or 1
    for bd in bars_data:
        bd["ornament_norm"] = round(bd["ornament_count"] / max_orn, 4)

    return {
        "matched":    True,
        "file_name":  file_name,
        "midi_name":  midi_path.name,
        "bars":       bars_data,
        "sections":   sections_summary,
        "var_labels": var_labels,
        "ornament_thresh_beats": ORNAMENT_THRESH,
    }


# ──────────────────────────────────────────────────────────────
#  Bar Map  (/api/midi/barmap/{file_name})
#  Returns per-bar start times (seconds) for playback tracking.
# ──────────────────────────────────────────────────────────────

@app.get("/api/midi/barmap/{file_name}")
def get_barmap(file_name: str):
    """
    Returns an array `bars` where bars[i] = start time (seconds) of
    MIDI bar i, derived from the MIDI tempo map.

    Used by the frontend to convert audio currentTime → bar index
    for real-time score highlighting during playback.
    """
    if mido is None:
        raise HTTPException(500, "mido not installed")

    midi_path = _find_midi_file(file_name)
    if midi_path is None:
        return {"matched": False, "file_name": file_name,
                "message": f"No MIDI found for '{file_name}' in TV_MIDI/"}

    mid    = mido.MidiFile(str(midi_path))
    tpb    = mid.ticks_per_beat or 480
    merged = list(mido.merge_tracks(mid.tracks))

    # Build tempo map
    tempo_map: list[tuple[int, int]] = [(0, 500_000)]
    beats_per_bar = 4
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type == "set_tempo":
            tempo_map.append((abs_t, msg.tempo))
        if msg.type == "time_signature":
            beats_per_bar = msg.numerator

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

    # Find total bars from last note
    last_tick = 0
    abs_t = 0
    for msg in merged:
        abs_t += msg.time
        if msg.type in ("note_on", "note_off"):
            last_tick = max(last_tick, abs_t)

    total_bars = int(last_tick / tpb / beats_per_bar) + 2  # +2 for safety

    # Build bar → start-time array
    bar_times = [
        round(tick2sec(bar * beats_per_bar * tpb), 4)
        for bar in range(total_bars)
    ]

    return {
        "matched":        True,
        "file_name":      file_name,
        "midi_name":      midi_path.name,
        "beats_per_bar":  beats_per_bar,
        "ticks_per_beat": tpb,
        "bars":           bar_times,   # index = bar number, value = seconds
    }


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

    total_sound = sum(durations)
    result["rest_ratio"] = max(0.0, (seg_dur - total_sound) / max(seg_dur, 1e-6))

    # ── Texture ───────────────────────────────────────────────────────
    # Build note-on / note-off event stream and scan for polyphony
    events: list[tuple[float, int]] = []
    for note in notes_sec:
        events.append((note["start_sec"], 1))
        events.append((note["start_sec"] + note["dur_sec"], -1))
    # At equal times: process note-offs before note-ons (conservative polyphony)
    events.sort(key=lambda x: (x[0], x[1]))

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


@app.get("/api/symbolic/{file_name}")
def get_symbolic_features(file_name: str):
    """
    Extract symbolic music features per segment from MIDI.

    Segment timestamps are read from the pre-extracted JSON feature file.
    MIDI is found via fuzzy match (_find_midi_file).

    Returns:
        { matched, segments: [{label, features: {key: float}}],
          feature_defs: [{key, label_zh, label_en, cat}] }
    """
    # ── Load segment timestamps from the existing JSON feature file ────
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
        if s.get("label", "C") != "C"   # skip Coda
    ]
    if not segments_meta:
        raise HTTPException(422, f"No segments found in feature file for '{file_name}'")

    # ── Locate MIDI ────────────────────────────────────────────────────
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
        "midi_name":    midi_path.name,
        "segments":     result_segments,
        "feature_defs": [
            {"key": k, "label_zh": zh, "label_en": en, "cat": cat, "chart_type": ct}
            for k, zh, en, cat, ct in SYMBOLIC_FEATURE_DEFS
        ],
    }


# ── /api/symbolic_audio/{file_name} ───────────────────────────────────────────
# All keys whose values can be reliably estimated from audio.
# Chroma-based (7) + BasicPitch-based (6) = 13 total when BP cache is present.
AUDIO_ESTIMABLE_KEYS: set[str] = {
    # Chroma / onset derived
    "pitch_class_entropy",
    "most_common_pc",
    "most_common_pc_prevalence",
    "pitch_variety",
    "tonal_clarity",
    "chromatic_density",
    "note_density",
    # BasicPitch transcription derived
    "pitch_range",
    "mean_pitch",
    "pitch_std",
    "bass_register_ratio",
    "high_register_ratio",
    "interval_class_variety",
}

# ── BasicPitch helpers ────────────────────────────────────────────────────────

BP_CACHE_SUFFIX = "_bp_notes.json"   # stored under FEATURE_DIR


def _find_audio_file(file_name: str) -> Path | None:
    """Locate the WAV file for a given file_name (same logic as /api/audio/)."""
    # Derive folder from file_name prefix (e.g. WAMozart_K265_1 → WAMozart_K265)
    parts = file_name.split("_")
    folder_guess = "_".join(parts[:-1]) if parts[-1].isdigit() else file_name
    candidate = AUDIO_DIR / folder_guess / f"{file_name}.wav"
    if candidate.exists():
        return candidate
    # Fallback: search all sub-directories
    if AUDIO_DIR.exists():
        for d in AUDIO_DIR.iterdir():
            if d.is_dir():
                p = d / f"{file_name}.wav"
                if p.exists():
                    return p
    return None


def _get_bp_notes(file_name: str) -> list[dict] | None:
    """
    Return BasicPitch note list for *file_name*, using a JSON cache.

    Cache format: [{"s": start_sec, "e": end_sec, "p": midi_pitch}, …]

    Returns None if audio file is missing or basic-pitch is not installed.
    First call for a file takes ~20 s; subsequent calls are instant.
    """
    cache_path = FEATURE_DIR / f"{file_name}{BP_CACHE_SUFFIX}"
    if cache_path.exists():
        with open(cache_path, encoding="utf-8") as fh:
            return json.load(fh)

    audio_path = _find_audio_file(file_name)
    if audio_path is None:
        return None

    try:
        import warnings as _w
        _w.filterwarnings("ignore")
        from basic_pitch.inference import predict as _bp_predict
        from basic_pitch import ICASSP_2022_MODEL_PATH as _BP_MODEL
    except ImportError:
        return None

    try:
        _, _, note_events = _bp_predict(str(audio_path), _BP_MODEL)
    except Exception:
        return None

    notes = [
        {"s": round(float(e[0]), 4), "e": round(float(e[1]), 4), "p": int(e[2])}
        for e in note_events
    ]
    with open(cache_path, "w", encoding="utf-8") as fh:
        json.dump(notes, fh)
    return notes


def _compute_bp_features(bp_notes: list[dict], seg_start: float, seg_end: float) -> dict:
    """
    Compute 6 pitch features from BasicPitch notes within [seg_start, seg_end).
    Returns an empty dict if fewer than 2 notes are found.
    """
    import math as _math

    seg_notes = [n for n in bp_notes if seg_start <= n["s"] < seg_end]
    if len(seg_notes) < 2:
        return {}

    pitches = [n["p"] for n in seg_notes]
    n = len(pitches)
    mean_p = sum(pitches) / n
    sorted_p = [n["p"] for n in sorted(seg_notes, key=lambda x: x["s"])]
    ivs = [abs(sorted_p[i + 1] - sorted_p[i]) for i in range(len(sorted_p) - 1)]
    ics = {min(iv % 12, 12 - iv % 12) for iv in ivs} if ivs else set()

    return {
        "pitch_range":            round(float(max(pitches) - min(pitches)), 4),
        "mean_pitch":             round(mean_p, 4),
        "pitch_std":              round(_math.sqrt(sum((p - mean_p) ** 2 for p in pitches) / n), 4),
        "bass_register_ratio":    round(sum(1 for p in pitches if p < 48) / n, 6),
        "high_register_ratio":    round(sum(1 for p in pitches if p > 72) / n, 6),
        "interval_class_variety": float(len(ics)),
    }


# ── Chroma / onset helper (unchanged logic, now a standalone function) ────────

def _compute_chroma_audio_symbolic(seg_feats: dict) -> dict:
    import math as _math

    result: dict[str, float] = {}
    chroma_raw = seg_feats.get("chroma_chromatic", [])
    if chroma_raw and len(chroma_raw) == 12:
        total = sum(chroma_raw) or 1.0
        chroma_n = [v / total for v in chroma_raw]
        ent = -sum(v * _math.log2(v) for v in chroma_n if v > 0)
        result["pitch_class_entropy"] = round(ent / _math.log2(12), 6)
        result["most_common_pc"] = float(chroma_n.index(max(chroma_n)))
        result["most_common_pc_prevalence"] = round(max(chroma_n), 6)
        threshold = max(chroma_n) * 0.05
        result["pitch_variety"] = float(sum(1 for v in chroma_n if v > threshold))
        result["chromatic_density"] = round(sum(1 for v in chroma_n if v > 0.01) / 12.0, 6)
    else:
        for k in ("pitch_class_entropy", "most_common_pc", "most_common_pc_prevalence",
                  "pitch_variety", "chromatic_density"):
            result[k] = 0.0

    pc_feat = seg_feats.get("pitch_contour", {})
    result["tonal_clarity"] = round(float(pc_feat.get("key_correlation", 0.0)), 6)
    result["note_density"] = round(float(seg_feats.get("onset_density", 0.0)), 6)
    return result


@app.get("/api/symbolic_audio/{file_name}")
def get_symbolic_audio_features(file_name: str):
    """
    Return audio-estimated symbolic features per segment.

    Two sources are combined:
      1. Chroma / onset_density → 7 features (always available when audio features exist)
      2. BasicPitch transcription → 6 pitch features (computed on first call, cached)

    BasicPitch cache: backend/features/{file_name}_bp_notes.json
    First request for an uncached piece takes ~20 s.

    Returns:
        {
          "file_name": str,
          "has_bp": bool,                      # whether BP features are included
          "audio_estimable_keys": [str],
          "segments": [{"label": str, "audio_features": {key: float}}]
        }
    """
    feat_path = FEATURE_DIR / f"{file_name}.json"
    if not feat_path.exists():
        raise HTTPException(404, f"Feature file not found for '{file_name}'.")

    with open(feat_path, encoding="utf-8") as fh:
        feat_data = json.load(fh)

    # Try to get BasicPitch notes (lazy, cached)
    bp_notes = _get_bp_notes(file_name)
    has_bp = bp_notes is not None

    segments_out = []
    for seg in feat_data.get("segments", []):
        lbl = seg.get("label", "")
        if lbl == "C":
            continue
        seg_start = float(seg.get("start_sec", 0))
        seg_end   = float(seg.get("end_sec", 0))

        audio_feats = _compute_chroma_audio_symbolic(seg.get("features", {}))

        if has_bp:
            bp_feats = _compute_bp_features(bp_notes, seg_start, seg_end)
            audio_feats.update(bp_feats)

        segments_out.append({"label": lbl, "audio_features": audio_feats})

    active_keys = AUDIO_ESTIMABLE_KEYS if has_bp else (
        AUDIO_ESTIMABLE_KEYS - {"pitch_range", "mean_pitch", "pitch_std",
                                 "bass_register_ratio", "high_register_ratio",
                                 "interval_class_variety"}
    )

    return {
        "file_name":            file_name,
        "has_bp":               has_bp,
        "audio_estimable_keys": sorted(active_keys),
        "segments":             segments_out,
    }
