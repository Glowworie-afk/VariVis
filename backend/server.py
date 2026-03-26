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
import json
import sys
from pathlib import Path

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
