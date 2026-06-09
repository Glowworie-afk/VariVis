# VariVis Product Document

> Version: v1.0 · 2026-06-09

---

## 1. Product Overview

### 1.1 One-line Definition

VariVis is an interactive visual analysis system for **Theme and Variations** music. It unifies multi-dimensional features from audio recordings and MusicXML scores, enabling researchers to systematically compare variation structures visually rather than by ear.

### 1.2 Target Users and Use Cases

| User Type | Typical Need |
|---|---|
| Music theory researchers | Quantitatively compare feature differences across variations of the same theme; contrast multiple performance versions |
| Music-background enthusiasts | Systematically understand the structural evolution of a piece without programming tools |

### 1.3 Core Value Proposition

A theme-and-variations work can have anywhere from a dozen to over thirty variation segments. Systematic cross-version comparison by listening alone is impractical. VariVis transforms feature data into interactive visualizations that support:

- **Cross-segment comparison**: Segment Overview lays out all variations horizontally for an at-a-glance overview
- **Multi-dimensional drill-down**: Click from the overview into a single segment to inspect pitch contour, rhythm bubbles, and similarity tree
- **Symbolic and audio fusion**: Score-derived (MXL) and audio-derived (pYIN) features displayed side by side

---

## 2. System Architecture

### 2.1 Technology Stack

**Backend**

| Item | Specification |
|---|---|
| Language | Python 3.11 |
| Framework | FastAPI 0.110+, Uvicorn (ASGI) |
| Core dependencies | librosa, numpy, scipy (audio features); music21 (MusicXML parsing); mido (MIDI); pandas + openpyxl (annotation table); pymupdf (PDF); python-multipart (file upload) |
| Start command | `cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000` |

**Frontend**

| Item | Specification |
|---|---|
| Language | TypeScript + React 18 |
| Build tool | Vite |
| Key libraries | Tone.js (audio playback); pako (MXL decompression) |
| Dev start | `cd frontend && npm run dev` |
| API proxy | Vite proxies `/api` to `localhost:8000` during development |

### 2.2 Directory Structure

```
VariVis/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app factory + scheduled cleanup task
│   │   ├── core/
│   │   │   └── config.py        # All filesystem path constants
│   │   ├── api/                 # Router layer (HTTP request/response only)
│   │   │   ├── pieces.py        # /api/pieces, /api/features, /api/audio
│   │   │   ├── score.py         # /api/score/*
│   │   │   ├── musicvis.py      # /api/musicvis/*
│   │   │   ├── midi.py          # /api/midi/*
│   │   │   ├── symbolic.py      # /api/symbolic/*
│   │   │   └── upload.py        # /api/upload/*
│   │   └── services/            # Business logic layer (independently testable)
│   │       ├── audio.py         # Audio feature extraction
│   │       ├── pitch_contour.py # pYIN pitch contour
│   │       ├── symbolic.py      # Symbolic features (MXL/MIDI)
│   │       ├── musicvis.py      # Skeleton melody analysis
│   │       ├── score_pitch.py   # Score-based pitch contour
│   │       ├── musicxml.py      # MXL file reading
│   │       ├── midi.py          # MIDI parsing
│   │       ├── score_matching.py# IMSLP PDF fuzzy matching
│   │       └── upload.py        # Upload parameter parsing
│   ├── data/
│   │   ├── TV_annotation.xlsx   # Segment timestamp annotations for all pieces
│   │   ├── TV_MIDI/             # MIDI files
│   │   ├── IMSLP/               # PDF scores
│   │   └── MusicXML/            # MXL scores
│   ├── features/                # Extracted JSON feature files (one per piece)
│   │   └── temp/                # Temporary feature files for user uploads
│   └── tests/                   # Automated tests (unit + integration)
│
├── frontend/
│   └── src/
│       ├── App.tsx              # Layout composition
│       ├── api/pieceApi.ts      # All backend request wrappers
│       ├── hooks/               # useAppNav, useLoadedPieces, usePieceList, etc.
│       ├── pages/               # CorpusView, PieceView, ScoreView
│       ├── features/            # Components organised by business domain
│       │   ├── drill-down/      # PitchPanel, RhythmPanel, HarmonicPanel
│       │   ├── structural/      # SimilarityTree
│       │   ├── feature-overview/# SegmentOverview, SymbolicHeatmap
│       │   ├── score/           # ScorePanel
│       │   └── extraction/      # UploadModal
│       ├── i18n/                # LangContext + translations.ts (EN/ZH)
│       ├── types/               # TypeScript type definitions
│       └── utils/               # pieceHelpers, pitchContour, etc. (pure functions)
│
└── TV_dataset_audio/            # WAV audio files (external dataset, not in git)
```

### 2.3 Data Flow

```
TV_annotation.xlsx
       │  read piece list + segment timestamps
       ▼
GET /api/pieces ──────────────────► frontend piece browser
       │
       │  user clicks a version
       ▼
GET /api/features/{file_name}
       │  read backend/features/{name}.json
       ▼
frontend renders four views:
  ├─ Segment Overview (thumbnail strip)
  ├─ Pitch Contour Tab
  ├─ Rhythm Timeline Tab
  └─ Similarity Tree Tab

GET /api/score/pdf/{file_name}   ──► right panel: Score (PDF)
GET /api/musicvis/harmonics/     ──► right panel: Harmonic (MXL)
```

---

## 3. Data and Content

### 3.1 Built-in Dataset (TV Dataset)

The dataset contains Theme and Variations works by **Beethoven, Mozart, and Haydn**, with **348 versions** currently extracted.

**File naming convention**

```
{ComposerAbbrev}{CatalogNumber}_{VersionNumber}

WAMozart_K265_1   → Mozart, K.265 (Twinkle Twinkle Variations), version 1
LBeethoven_OP34_2 → Beethoven, Op.34, version 2
JHaydn_XVII2_1    → Haydn, Hob.XVII:2, version 1
```

**Segment structure**

Each piece is segmented by timestamps in `TV_annotation.xlsx`:

| Label | Meaning |
|---|---|
| `T` | Theme |
| `V1`, `V2`, `V3`… | Variation 1, 2, 3… |
| `C` | Connector or Coda — skipped in some analyses |

These three composers were chosen because the TAVERN dataset provides Roman-numeral harmonic annotations for their variation works, making it the most widely used quantitative foundation in T&V research. Mozart K.265 serves as a familiar reference baseline for evaluators.

### 3.2 Feature Extraction Pipeline

Extraction is an **offline** one-time operation run by backend scripts in batch. Results are stored as `backend/features/{file_name}.json`.

**Features extracted per segment**

| Category | Fields |
|---|---|
| Tonality / Chroma | `chroma_chromatic` (chromatic order), `chroma_cof` (circle-of-fifths order), `dominant_pitch` |
| Pitch contour | `pitch_contour` (MIDI value sequence) — see three-tier priority in §8.1 |
| Dynamics / Energy | `rms_mean/std/max`, `dynamic_range_db` |
| Timbre | `mfcc_mean/std` (13-dim), `spectral_centroid_mean/std`, `spectral_contrast_mean`, `spectral_flatness_mean`, `zcr_mean`, `tonnetz_mean` |
| Rhythm | `onset_density` (onsets/second), `tempo` (BPM) |
| Chord recognition | `chord_recognition` (template matching) |
| Compressed time-series | `compressed.rms`, `compressed.spectral_centroid`, `compressed.chroma_cof` (all 64 frames) |

**JSON top-level structure**

```json
{
  "metadata": {
    "file_name": "WAMozart_K265_1",
    "music_name": "...",
    "composer": "Mozart",
    "total_duration_sec": 312.5,
    "compressed_frames": 64,
    "cof_order": [0,7,2,9,4,11,6,1,8,3,10,5],
    "cof_names": ["C","G","D","A","E","B","F#","Db","Ab","Eb","Bb","F"]
  },
  "segments": [
    {
      "label": "T",
      "index": 0,
      "start_sec": 0.0,
      "end_sec": 45.2,
      "duration_sec": 45.2,
      "features": { ... }
    }
  ]
}
```

### 3.3 User Uploads and Temporary Pieces

Users may upload custom files (any combination) within the current session:

- MusicXML / .mxl score
- Audio file (WAV/MP3) + segment boundary timestamps (MM.SS format, comma-separated)
- PDF score

**available_views mechanism**

The backend determines which views are unlocked based on the files actually provided:

| `available_views` value | Corresponding view | Required file |
|---|---|---|
| `corpus_view` | Segment Overview + drill-down tabs | Audio or MXL (either) |
| `symbolic_heatmap` | Feature Comparison Heatmap | MXL |
| `harmonic_function` | Harmonic Function View | MXL with ≥2 sections |
| `overview` | Overview statistics view | Audio |

**Temporary file management**

- Filenames are prefixed with `temp_`
- Files are distributed across `features/temp/` (JSON), `data/MusicXML/` (MXL), `data/IMSLP/` (PDF)
- Deleting from the frontend calls `DELETE /api/upload/temp/{name}` to clean up synchronously
- The server automatically purges `temp_*` files older than 24 hours, checked every hour

---

## 4. User Interface

### 4.1 Overall Layout

```
┌───────────────────┬──────────────────────────────┬──────────────────┐
│   Left Sidebar    │         Main Area             │   Right Panel    │
│                   │                              │                  │
│  Piece browser    │  Segment Overview (top)      │  Score (PDF)     │
│  ─────────        │  ─────────────────────       │  or              │
│  Feature          │  Pitch Contour Tab           │  Harmonic (MXL)  │
│  Comparison       │  Rhythm Timeline Tab         │                  │
│  Heatmap          │  Similarity Tree Tab         │                  │
└───────────────────┴──────────────────────────────┴──────────────────┘
```

### 4.2 Left Sidebar

**Piece browser (upper half)**

Three-level tree: Composer → Piece → Performance version (v1, v2…).

- Click a version number to load it; multiple pieces can be loaded simultaneously for comparison
- A green M badge indicates a matching MIDI file exists
- The "Upload piece" button at the top opens the upload modal

**Feature Comparison Heatmap (lower half)**

A **segment × symbolic feature** matrix heatmap for the currently focused piece, showing Δz deviation across 30+ score-derived features for each variation. Only visible when the piece has a matching MXL file; otherwise shows "No data source".

### 4.3 Main Area Views

**Segment Overview (top thumbnail strip)**

All segments (T, V1, V2…) laid out horizontally. Each cell renders:

- A circle-of-fifths radar chart (chroma distribution)
- A Hevner emotion label
- Playback controls (play / pause / seek)

Clicking a segment cell updates all three tabs below to show that segment's detail views.

**Pitch Contour Tab**

Line-card view of each variation's pitch contour. Pitch is shown relative to the tonal centre in semitones.

- Click a single card to enlarge
- Click another to overlay and compare; contour similarity score is shown

Data source priority (see §8.1 for rationale):
1. MXL score → `score_beat_midi_relative`
2. pYIN audio → `beat_midi_relative` / `midi_relative`
3. Chroma-inferred tonic (tonal centre only, no time-series contour)

**Rhythm Timeline Tab (Rhythm Bubbles)**

Bubble chart where each bubble represents one variation segment:

- Bubble size = loudness (RMS)
- Bubble opacity = local onset density
- X-axis = time, Y-axis = variation index

**Similarity Tree Tab**

A Prim MST similarity tree computed from three feature dimensions — Pitch (P), Rhythm (R), Harmony (H) — rooted at the Grundgestalt (Theme).

- Edge colour/weight represents the penalty k: k < 0.30 very similar → k > 0.70 divergent
- Node labels P / R / H indicate which dimension differs most from the parent

### 4.4 Right Panel

Two modes toggled by buttons at the top:

| Mode | Content | Data source |
|---|---|---|
| Score | Embedded PDF iframe | `data/IMSLP/`, fuzzy-matched by catalog number |
| Harmonic | Interactive MusicXML renderer + harmonic function distribution bar chart | `data/MusicXML/` |

The Harmonic button is only shown when the current piece has a matching MXL file. Switching to Harmonic mode hides the main area and expands the score panel to full width (see §8.2 for rationale).

---

## 5. Typical Usage Paths

### Path A: Analysing an extracted piece

```
Start backend → Open frontend
→ Expand a composer node in the left sidebar
→ Click a version number (e.g. WAMozart_K265_1) to load
→ Main area top: Segment Overview shows all variation thumbnails
→ Click a segment thumbnail → tabs below switch to that segment's detail views
→ Switch between Pitch Contour / Rhythm Timeline / Similarity Tree for different dimensions
→ Right panel: view Score (PDF) or switch to Harmonic (MXL harmonic view)
```

### Path B: Uploading a custom file for temporary analysis

```
Click "Upload piece" in the left sidebar → modal opens
→ Enter piece name (required)
→ If uploading audio, enter segment boundary timestamps
  (MM.SS format, comma-separated, e.g. 0.00, 1.30, 3.15)
→ Confirm → backend processes and returns available_views
→ A temporary piece card appears in the sidebar; main area shows available views
→ After analysis, click × to delete; backend cleans up all associated files
```

---

## 6. API Reference

Base URL: `/api` (proxied to `localhost:8000` during development by Vite)

### 6.1 Endpoint Quick Reference

**Pieces and features**

| Method | Path | Description |
|---|---|---|
| GET | `/api/pieces` | List all piece metadata (reads TV_annotation.xlsx) |
| GET | `/api/features/{file_name}` | Return extracted feature JSON; 404 = not yet extracted |
| GET | `/api/audio/{file_name}` | Return audio file (WAV, for the player) |

**Score**

| Method | Path | Description |
|---|---|---|
| GET | `/api/score/pdf/{file_name}` | Return matched IMSLP PDF; 404 = no match |
| GET | `/api/score/match` | Return match result only (no file), for pre-checking |
| GET | `/api/score/musicxml/{file_name}` | Return raw MXL XML |
| GET | `/api/score/mxl_notes/{file_name}` | Extract notes from MXL for Tone.js synthesis |

**MusicXML analysis**

| Method | Path | Description |
|---|---|---|
| GET | `/api/musicvis/list` | List files in the MusicXML directory |
| GET | `/api/musicvis/xml/{file_name}` | Return decompressed XML |
| GET | `/api/musicvis/sections/{file_name}` | Return rehearsal-mark section list |
| GET | `/api/musicvis/chords/{file_name}` | Per-measure chords + T/S/D/O classification |
| GET | `/api/musicvis/skeleton/{file_name}` | Theme skeleton melody (Wang et al. 2025 algorithm) |
| GET | `/api/musicvis/ornaments/{file_name}` | Ornament highlights per variation |
| GET | `/api/musicvis/chordtones/{file_name}` | Chord tone highlights per variation |
| GET | `/api/musicvis/harmonics/{file_name}` | Harmonic function distribution (for the right panel) |

**MIDI**

| Method | Path | Description |
|---|---|---|
| GET | `/api/midi/notes/{file_name}` | MIDI note list (for piano-roll rendering) |
| GET | `/api/midi/{file_name}` | Per-variation structural analysis (tempo, key, metre, etc.) |

**Symbolic features**

| Method | Path | Description |
|---|---|---|
| GET | `/api/symbolic/{file_name}` | 30+ symbolic features per segment + three distribution histograms |

**Upload**

| Method | Path | Description |
|---|---|---|
| POST | `/api/upload/process` | Upload and process a temporary piece; returns available_views |
| GET | `/api/upload/temp_pdf/{temp_name}` | Serve a temporarily uploaded PDF |
| DELETE | `/api/upload/temp/{temp_name}` | Delete all files associated with a temporary upload |

---

## 7. Glossary

### 7.1 Music Terms (visible in the frontend UI)

**Segment**
VariVis divides each Theme and Variations work into structural segments: T (Theme), V1/V2… (Variations), C (Coda/Connector). Segment boundaries come from timestamps in `TV_annotation.xlsx`, or are inferred automatically from MXL rehearsal marks.

**Pitch Contour**
A line graph with time on the X-axis and MIDI pitch on the Y-axis, showing melodic shape. VariVis displays pitch relative to the tonal centre (in semitones) to enable cross-version comparison.

**RMS / Loudness**
Root mean square amplitude of the audio signal, reflecting perceived loudness. Encoded as bubble size in the Rhythm Bubbles view.

**Onset Density**
Number of note onset events per second, reflecting playing density (unit: onsets/s). Encoded as bubble opacity in the Rhythm Bubbles view.

**Tonic / Subdominant / Dominant**
The three functional categories of Western tonal harmony, corresponding to the three colour groups in the Harmonic Function Distribution bar chart. "Other" covers chords outside these categories.

**Grundgestalt**
A concept introduced by Schoenberg referring to the most fundamental motivic form of a work. In VariVis, it labels the root node of the Similarity Tree (the Theme segment), from which all variations are derived.

**Major / Minor**
The mode of a scale. VariVis annotates the current segment's mode on Pitch Contour cards and in the Score panel.

### 7.2 System-specific Concepts

**available_views**
A field written into the feature JSON after the backend processes an uploaded file. It records which frontend views can be activated for that piece (see §3.3).

**Temp Piece**
A piece uploaded by the user that is not persisted to the permanent database. Filenames are prefixed with `temp_`. They can be deleted manually before the session ends; the server auto-purges them after 24 hours.

**64-frame Compression (Compressed Features)**
To normalise heatmap rendering across segments of different durations, time-series features (RMS, spectral centroid, chroma) are downsampled to a fixed 64 frames. Sample points are distributed proportionally to segment duration and stored in the `features.compressed` field.

**COF Order (Circle-of-Fifths Order)**
The internal index `[0,7,2,9,4,11,6,1,8,3,10,5]`, corresponding to pitch names `[C, G, D, A, E, B, F#, Db, Ab, Eb, Bb, F]`. All chroma-related arrays are stored in this order; adjacent pitches have stronger harmonic relationships, making heatmap visual patterns more meaningful.

---

## 8. Design Decision Records

### 8.1 Three-tier Priority for Pitch Contour

The pitch contour has three possible data sources, used in the following priority order by both frontend and backend:

```
1. score_beat_midi_relative  (MXL score)       ← highest priority
2. beat_midi_relative / midi_relative  (pYIN)  ← second choice
3. chroma-inferred tonic  (tonal centre only)  ← fallback
```

**Rationale**: The score source is the "ideal melody" independent of performance, unaffected by recording noise or expressive timing. pYIN reflects actual playing but is limited by recording quality. Chroma inference only yields a tonal centre, not a time-series contour.

### 8.2 Harmonic Mode Expands to Full Width

Switching to Harmonic (MusicXML) mode hides the main area entirely and expands the score panel to full width.

**Rationale**: MusicXML renderers (OSMD/VexFlow) need sufficient width to lay out staves correctly. In a three-column layout the right panel is too narrow, causing noteheads to overlap or lines to wrap incorrectly. Full width was the simplest working solution found at the time.

### 8.3 Rule-based Hevner Emotion Mapping

Emotion classification uses hard-coded `if/else` rules (`pickHevnerIdx`) rather than a trained classifier.

**Rationale**: Insufficient data for training; the rule logic is based on Russell V/A coordinate regions, making it interpretable and adjustable; the mappings reference typical correspondences in music psychology literature.

### 8.4 Preload All Extracted Pieces at Startup

On startup the app automatically calls `fetchFeatures` for all `extracted: true` pieces rather than loading on demand.

**Rationale**: The corpus scatter plot in Corpus View requires data for all pieces to render completely. On-demand loading would cause data points to appear over time, creating an inconsistent experience. The trade-off is a burst of concurrent requests at startup.

### 8.5 Choice of TV Dataset and Three Composers

The dataset was provided by a research collaborator and comes with complete segment timestamp annotations (`TV_annotation.xlsx`). Mozart, Beethoven, and Haydn were chosen because the TAVERN dataset provides Roman-numeral harmonic annotations for their variation works, making it the most widely used quantitative foundation in T&V research.

---

## 9. dev Branch Change Summary

The following covers all changes relative to `main` (18 + 3 commits).

### Backend Refactoring

| Change | Description |
|---|---|
| Layered `app/` architecture | Split into `api/` (router layer) + `services/` (business logic); routes contain no computation |
| Remove legacy `server.py` | And all pipeline scripts scattered in the `backend/` root (`extract_features.py`, etc.) |
| Data directory migration | All external data moved into `backend/data/`; path constants centralised in `core/config.py` |
| Temporary file management | `features/temp/` separated from permanent storage; `main.py` purges expired temp files on startup and hourly |
| Remove `SCORES_DIR` dead code | Fixes the `GET /api/score/musicxml` route |
| Remove CLI pipeline entry points | Service modules no longer contain command-line execution logic |
| Remove ExtractionPanel end-to-end | Frontend extraction panel + backend `/api/extract` SSE route both removed |

### Frontend Refactoring

| Change | Description |
|---|---|
| Decompose `App.tsx` | State logic extracted into `hooks/`; types moved to `types/`; target < 100 lines |
| Centralise i18n | Replaced with `LangContext` + `translations.ts` dictionary; `lang` prop drilling removed |
| Restructure directory | Reorganised into `features/` + `pages/` by business domain |
| Path alias | Added `@` alias pointing to `src/` to eliminate relative-path hell |
| Dead code removal | Unused exports removed by knip + tsc; all ESLint errors resolved |

### Bug Fixes

| File | Issue |
|---|---|
| `app/api/symbolic.py` | `compute_symbolic_features` and `compute_distributions` were called but never imported; `GET /api/symbolic/` crashed whenever an MXL file was present |

### Miscellaneous

- Mental Landscape dead code removed end-to-end (`mental.*` entries in `translations.ts`, display string in `UploadModal.tsx`, `available_views` entry in `upload.py`)
- `CLAUDE.md` deleted (content consolidated into this document)
- `.claude/` removed from git tracking

---

### Test Coverage

| Type | Location | Cases |
|---|---|---|
| Pure function unit tests | `tests/test_services/` | 142 |
| API integration tests | `tests/test_api/` | 54 |
| **Total** | | **196** |

Run command:

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/ -v
```

---
---

# VariVis 产品文档

> 版本：v1.0 · 2026-06-09

---

## 一、产品概述

### 1.1 一句话定义

VariVis 是一个面向**主题与变奏曲（Theme and Variations）**的交互式可视分析系统。它将音频录音与 MusicXML 乐谱的多维特征统一呈现，让研究者能够用"看"代替"听"来系统比较变奏结构。

### 1.2 目标用户与使用场景

| 用户类型 | 典型需求 |
|---|---|
| 音乐理论研究者 | 定量比较同一主题在不同变奏间的特征差异；对比多个演奏版本 |
| 有音乐背景的爱好者 | 系统性理解一部作品的结构演变，无需编程工具 |

### 1.3 核心价值主张

同一首变奏曲拥有十几个到三十多个变奏段落，跨版本比较时靠聆听难以形成系统认知。VariVis 将特征数据转化为可交互的可视化视图，支持：

- **跨段落比较**：Segment Overview 横向排列所有变奏，一眼看出整曲走势
- **多维钻取**：从概览点击进入单段落，查看音高轮廓、节奏气泡、相似度树
- **符号与音频融合**：乐谱来源（MXL）与音频来源（pYIN）的特征并列显示

---

## 二、系统架构

### 2.1 技术栈

**后端**

| 项目 | 规格 |
|---|---|
| 语言 | Python 3.11 |
| 框架 | FastAPI 0.110+，Uvicorn（ASGI） |
| 核心依赖 | librosa、numpy、scipy（音频特征）；music21（MusicXML 解析）；mido（MIDI）；pandas + openpyxl（注释表）；pymupdf（PDF）；python-multipart（文件上传） |
| 启动命令 | `cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000` |

**前端**

| 项目 | 规格 |
|---|---|
| 语言 | TypeScript + React 18 |
| 构建工具 | Vite |
| 主要库 | Tone.js（音频播放）；pako（MXL 解压） |
| 开发启动 | `cd frontend && npm run dev` |
| API 代理 | 开发时 Vite 将 `/api` 代理至 `localhost:8000` |

### 2.2 目录结构

```
VariVis/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 应用工厂 + 定时清理任务
│   │   ├── core/
│   │   │   └── config.py        # 所有路径常量
│   │   ├── api/                 # 路由层（仅处理 HTTP 入参/出参）
│   │   │   ├── pieces.py        # /api/pieces, /api/features, /api/audio
│   │   │   ├── score.py         # /api/score/*
│   │   │   ├── musicvis.py      # /api/musicvis/*
│   │   │   ├── midi.py          # /api/midi/*
│   │   │   ├── symbolic.py      # /api/symbolic/*
│   │   │   └── upload.py        # /api/upload/*
│   │   └── services/            # 业务逻辑层（可独立测试）
│   │       ├── audio.py         # 音频特征提取
│   │       ├── pitch_contour.py # pYIN 音高轮廓
│   │       ├── symbolic.py      # 符号特征（MXL/MIDI）
│   │       ├── musicvis.py      # 骨架旋律分析
│   │       ├── score_pitch.py   # 乐谱音高轮廓
│   │       ├── musicxml.py      # MXL 文件读取
│   │       ├── midi.py          # MIDI 解析
│   │       ├── score_matching.py# IMSLP PDF 模糊匹配
│   │       └── upload.py        # 上传参数解析
│   ├── data/
│   │   ├── TV_annotation.xlsx   # 所有曲目的段落时间戳注释
│   │   ├── TV_MIDI/             # MIDI 文件
│   │   ├── IMSLP/               # PDF 乐谱
│   │   └── MusicXML/            # MXL 乐谱
│   ├── features/                # 已提取的 JSON 特征文件（每曲一个）
│   │   └── temp/                # 用户上传的临时特征文件
│   └── tests/                   # 自动化测试（单元 + 接口）
│
├── frontend/
│   └── src/
│       ├── App.tsx              # 布局组合
│       ├── api/pieceApi.ts      # 所有后端请求封装
│       ├── hooks/               # useAppNav, useLoadedPieces, usePieceList 等
│       ├── pages/               # CorpusView, PieceView, ScoreView
│       ├── features/            # 按功能域组织的组件
│       │   ├── drill-down/      # PitchPanel, RhythmPanel, HarmonicPanel
│       │   ├── structural/      # SimilarityTree
│       │   ├── feature-overview/# SegmentOverview, SymbolicHeatmap
│       │   ├── score/           # ScorePanel
│       │   └── extraction/      # UploadModal
│       ├── i18n/                # LangContext + translations.ts（中英双语）
│       ├── types/               # TypeScript 类型定义
│       └── utils/               # pieceHelpers, pitchContour 等纯函数
│
└── TV_dataset_audio/            # WAV 音频文件（外部数据集，不入库）
```

### 2.3 数据流

```
TV_annotation.xlsx
       │ 读取曲目列表 + 段落时间戳
       ▼
GET /api/pieces ──────────────────► 前端曲目树形浏览器
       │
       │ 用户点击版本号
       ▼
GET /api/features/{file_name}
       │ 读取 backend/features/{name}.json
       ▼
前端渲染四个视图：
  ├─ Segment Overview（缩略图条）
  ├─ Pitch Contour Tab
  ├─ Rhythm Timeline Tab
  └─ Similarity Tree Tab

GET /api/score/pdf/{file_name} ──► 右侧 Score 面板（PDF）
GET /api/musicvis/harmonics/    ──► 右侧 Harmonic 面板（MXL）
```

---

## 三、数据与内容

### 3.1 内置数据集（TV Dataset）

数据集包含 **Beethoven、Mozart、Haydn** 三位作曲家的主题与变奏曲，目前已提取 **348 个版本**。

**文件命名规则**

```
{作曲家缩写}{目录号}_{版本号}

WAMozart_K265_1   → Mozart，K.265（小星星变奏），版本 1
LBeethoven_OP34_2 → Beethoven，Op.34，版本 2
JHaydn_XVII2_1    → Haydn，Hob.XVII:2，版本 1
```

**段落结构**

每首曲目按 `TV_annotation.xlsx` 中的时间戳分段：

| 标签 | 含义 |
|---|---|
| `T` | 主题（Theme） |
| `V1`、`V2`、`V3`… | 第 1、2、3…变奏（Variation） |
| `C` | 连接段或尾声（Coda），部分分析中跳过 |

选择这三位作曲家的原因：TAVERN 数据集已对其变奏曲提供罗马数字和声标注，是 T&V 量化研究领域最常用的基础；Mozart K.265 作为西方钢琴教学标准曲目，可为评估者提供熟悉的参照基线。

### 3.2 特征提取管线

提取是**离线**的一次性操作，由后端脚本批量执行，结果存为 `backend/features/{file_name}.json`。

**每个段落提取的特征**

| 类别 | 字段 |
|---|---|
| 调性 / 色度 | `chroma_chromatic`（半音阶序）、`chroma_cof`（五度圈序）、`dominant_pitch` |
| 音高轮廓 | `pitch_contour`（MIDI 值序列）— 见三级优先级说明 |
| 动态 / 能量 | `rms_mean/std/max`、`dynamic_range_db` |
| 音色 | `mfcc_mean/std`（13 维）、`spectral_centroid_mean/std`、`spectral_contrast_mean`、`spectral_flatness_mean`、`zcr_mean`、`tonnetz_mean` |
| 节奏 | `onset_density`（每秒起音数）、`tempo`（BPM）|
| 和弦识别 | `chord_recognition`（模板匹配） |
| 固定帧压缩 | `compressed.rms`、`compressed.spectral_centroid`、`compressed.chroma_cof`（均为 64 帧）|

**JSON 文件顶层结构**

```json
{
  "metadata": {
    "file_name": "WAMozart_K265_1",
    "music_name": "...",
    "composer": "Mozart",
    "total_duration_sec": 312.5,
    "compressed_frames": 64,
    "cof_order": [0,7,2,9,4,11,6,1,8,3,10,5],
    "cof_names": ["C","G","D","A","E","B","F#","Db","Ab","Eb","Bb","F"]
  },
  "segments": [
    {
      "label": "T",
      "index": 0,
      "start_sec": 0.0,
      "end_sec": 45.2,
      "duration_sec": 45.2,
      "features": { ... }
    }
  ]
}
```

### 3.3 用户上传与临时曲目

用户可在当前会话内上传自定义文件（任意组合）：

- MusicXML / .mxl 乐谱
- 音频文件（WAV/MP3）+ 段落边界时间戳（MM.SS 格式，逗号分隔）
- PDF 乐谱

**available_views 机制**

后端根据实际上传的文件类型决定哪些视图可用：

| `available_views` 值 | 对应视图 | 所需文件 |
|---|---|---|
| `corpus_view` | Segment Overview + 钻取 Tab | 音频 或 MXL（任一） |
| `symbolic_heatmap` | Feature Comparison Heatmap | MXL |
| `harmonic_function` | Harmonic Function View | MXL 且 ≥2 段落 |
| `overview` | Overview 统计视图 | 音频 |

**临时文件管理**

- 文件名以 `temp_` 前缀标识
- 分散存储于 `features/temp/`（JSON）、`data/MusicXML/`（MXL）、`data/IMSLP/`（PDF）
- 前端删除时调用 `DELETE /api/upload/temp/{name}` 同步清理
- 后端每小时自动清理超过 24 小时的 `temp_*` 文件

---

## 四、用户界面

### 4.1 整体布局

```
┌───────────────────┬──────────────────────────────┬──────────────────┐
│    左侧边栏        │          主区域               │   右侧面板        │
│                   │                              │                  │
│  曲目树形浏览      │  Segment Overview（顶部）    │  Score（PDF）    │
│  ─────────        │  ─────────────────────       │  或              │
│  Feature          │  Pitch Contour Tab           │  Harmonic（MXL） │
│  Comparison       │  Rhythm Timeline Tab         │                  │
│  Heatmap          │  Similarity Tree Tab         │                  │
└───────────────────┴──────────────────────────────┴──────────────────┘
```

### 4.2 左侧边栏

**曲目浏览器（上半部分）**

三层树形结构：作曲家 → 曲目 → 演奏版本（v1、v2…）。

- 点击版本号加载该曲目，支持多曲同时加载对比
- 绿色 M 徽章表示有匹配的 MIDI 文件
- 顶部「上传乐曲」按钮打开上传弹窗

**Feature Comparison Heatmap（下半部分）**

当前聚焦曲目的**段落 × 符号特征**矩阵热图，展示各变奏在 30+ 项乐谱特征上的 Δz 偏差。仅当曲目有匹配的 MXL 文件时显示，否则提示 No data source。

### 4.3 主区域视图

**Segment Overview（顶部缩略图条）**

横向排列所有段落（T、V1、V2…），每格绘制：

- 五度圈雷达图（色度分布）
- Hevner 情感标签
- 播放控制按钮（播放 / 暂停 / 跳转）

点击某段落后，下方三个 Tab 随之更新至该段落的详细视图。

**Pitch Contour Tab**

每个变奏段落的音高轮廓折线卡片，音高以半音为单位相对主调中心显示。

- 点击单张卡片放大
- 再点另一张叠加对比，显示轮廓相似度（Contour similarity）

数据来源优先级（详见第八节设计决策）：
1. 乐谱 MXL → `score_beat_midi_relative`
2. pYIN 音频分析 → `beat_midi_relative` / `midi_relative`
3. 色度推算的主调（仅调性，无时序轮廓）

**Rhythm Timeline Tab（Rhythm Bubbles）**

气泡图，每个气泡代表一个变奏段落：

- 气泡大小 = 响度（RMS）
- 气泡透明度 = 局部起音密度（Onset density）
- 横轴 = 时间，纵轴 = 变奏编号

**Similarity Tree Tab**

基于音高（P）、节奏（R）、和声（H）三维特征计算的 Prim MST 相似度树，以 Grundgestalt（根节点 · 主题）为起点展开。

- 连线颜色 / 粗细表示 k 值（惩罚距离）：k < 0.30 极相似 → k > 0.70 差异大
- 节点标注 P / R / H 表示该段落与父节点在哪个维度差异最显著

### 4.4 右侧面板

两种模式，顶部按钮切换：

| 模式 | 内容 | 数据来源 |
|---|---|---|
| Score | PDF 乐谱内嵌 iframe | `data/IMSLP/`，模糊匹配目录编号 |
| Harmonic | MusicXML 交互式渲染 + 和声功能分布柱状图 | `data/MusicXML/` |

Harmonic 按钮仅在当前曲目有匹配 MXL 文件时显示。切换至 Harmonic 模式后，主区域隐藏，乐谱面板展开为全宽（原因见第八节设计决策）。

---

## 五、典型使用路径

### 路径 A：加载已提取曲目进行分析

```
启动后端 → 打开前端
→ 左侧边栏展开作曲家节点
→ 点击版本号（如 WAMozart_K265_1）加载曲目
→ 主区域顶部：Segment Overview 显示全部变奏缩略图
→ 点击某段落缩略图 → 下方 Tab 切换至对应段落的详细视图
→ 切换 Pitch Contour / Rhythm Timeline / Similarity Tree 分析不同维度
→ 右侧面板：查看 Score（PDF）或切换 Harmonic（MXL 和声视图）
```

### 路径 B：上传自定义文件临时分析

```
点击左侧边栏「上传乐曲」→ 弹窗选择文件
→ 填写曲名（必填）
→ 若上传音频，需填写段落边界时间戳（MM.SS 格式，逗号分隔，如 0.00, 1.30, 3.15）
→ 点击确认 → 后端处理并返回 available_views
→ 左侧出现临时曲目卡片，主区域显示其可用视图
→ 分析完成后点击 × 删除，后端同步清理临时文件
```

---

## 六、API 接口

基础地址：`/api`（开发时由 Vite 代理至 `localhost:8000`）

### 6.1 端点速查表

**曲目与特征**

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/pieces` | 列出所有曲目元信息（读 TV_annotation.xlsx） |
| GET | `/api/features/{file_name}` | 返回已提取的特征 JSON；404 = 未提取 |
| GET | `/api/audio/{file_name}` | 返回音频文件（WAV，用于播放器） |

**乐谱**

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/score/pdf/{file_name}` | 返回匹配的 IMSLP PDF；404 = 无匹配 |
| GET | `/api/score/match` | 仅返回匹配结果（不返回文件），用于预检 |
| GET | `/api/score/musicxml/{file_name}` | 返回 MXL 原始 XML |
| GET | `/api/score/mxl_notes/{file_name}` | 提取 MXL 中的音符，用于 Tone.js 合成 |

**MusicXML 分析**

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/musicvis/list` | 列出 MusicXML 目录中的文件 |
| GET | `/api/musicvis/xml/{file_name}` | 返回解压后的 XML |
| GET | `/api/musicvis/sections/{file_name}` | 返回排练标记分段列表 |
| GET | `/api/musicvis/chords/{file_name}` | 逐小节和弦 + T/S/D/O 功能分类 |
| GET | `/api/musicvis/skeleton/{file_name}` | 主题骨架旋律（Wang et al. 2025 算法） |
| GET | `/api/musicvis/ornaments/{file_name}` | 各变奏装饰音高亮 |
| GET | `/api/musicvis/chordtones/{file_name}` | 各变奏和弦音高亮 |
| GET | `/api/musicvis/harmonics/{file_name}` | 和声功能分布（用于右侧 Harmonic 面板） |

**MIDI**

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/midi/notes/{file_name}` | MIDI 音符列表（用于钢琴卷帘） |
| GET | `/api/midi/{file_name}` | 每变奏结构分析（速度、调性、节拍等） |

**符号特征**

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/symbolic/{file_name}` | 每段落 30+ 项符号特征 + 三类分布直方图 |

**上传**

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/api/upload/process` | 上传并处理临时曲目，返回 available_views |
| GET | `/api/upload/temp_pdf/{temp_name}` | 返回临时上传的 PDF |
| DELETE | `/api/upload/temp/{temp_name}` | 删除临时上传的全部文件 |

---

## 七、核心概念词典

### 7.1 音乐术语（仅前端实际可见）

**Segment / 变奏段落**
VariVis 将每首变奏曲按结构分段：T（主题）、V1/V2…（变奏）、C（尾声/连接）。段落边界来自 `TV_annotation.xlsx` 中的时间戳，或由 MXL 排练标记自动推断。

**Pitch Contour（音高轮廓）**
以时间为横轴、MIDI 音高为纵轴的折线图，表现旋律走向。VariVis 中展示相对音高（以主调为基准，单位：半音），便于跨版本比较。

**RMS / Loudness（均方根能量 / 响度）**
音频信号的均方根幅度，反映感知响度。Rhythm Bubbles 视图中气泡大小编码此值。

**Onset Density（起音密度）**
每秒内音符起音事件的数量，反映演奏密度（单位：次/秒）。Rhythm Bubbles 视图中气泡透明度编码此值。

**Tonic / Subdominant / Dominant（主功能 / 下属功能 / 属功能）**
西方调性和声的三大功能类别，对应 Harmonic Function Distribution 柱状图的三个颜色分组。「Other」为不属于以上三类的和弦。

**Grundgestalt（原始形态）**
Schoenberg 提出的概念，指作品中最基础的动机形态。VariVis Similarity Tree 中以此标注根节点（主题段落），表示其他变奏均从此派生。

**Major / Minor（大调 / 小调）**
音阶的调式。VariVis 在 Pitch Contour 卡片和 Score 面板中标注当前段落的调式。

### 7.2 系统专有概念

**available_views**
后端处理上传文件后写入特征 JSON 的字段，记录该曲目可以激活哪些前端视图（见第三节 3.3 节）。

**Temp Piece（临时曲目）**
用户上传但不入永久数据库的曲目。文件名以 `temp_` 为前缀，会话结束前可手动删除，服务器每 24 小时自动清理。

**64 帧压缩（Compressed Features）**
为统一不同时长段落的热图渲染，将时序特征（RMS、频谱质心、色度）降采样至固定 64 帧。采样点按段落时长等比分布，存入 `features.compressed` 字段。

**COF Order（五度圈排列顺序）**
VariVis 内部使用的索引 `[0,7,2,9,4,11,6,1,8,3,10,5]`，对应音名 `[C, G, D, A, E, B, F#, Db, Ab, Eb, Bb, F]`。所有色度相关数组均按此顺序存储，相邻音具有更强的和声关联性，热图视觉模式更有意义。

---

## 八、设计决策记录

### 8.1 音高轮廓的三级优先级

音高轮廓有三个数据来源，前端和后端均按以下优先级使用：

```
1. score_beat_midi_relative（乐谱 MXL）   ← 最优先
2. beat_midi_relative / midi_relative（pYIN 音频分析）  ← 次选
3. chroma_cof 推算主调（仅调性，无时序轮廓）             ← 兜底
```

**原因**：乐谱来源是演奏无关的「理想旋律」，不受录音噪音和弹奏偏差影响，最适合跨版本比较。pYIN 反映实际演奏但受录音质量限制。色度推算只能给出调性中心，无法产生时序轮廓。

### 8.2 Harmonic 模式切换为全宽布局

切换到 Harmonic（MusicXML）模式时，主区域完全隐藏，乐谱面板展开全宽。

**原因**：MusicXML 渲染器（OSMD/VexFlow）需要足够宽度才能正确排版五线谱，在三栏布局中右侧面板宽度不足，会导致符头重叠或换行异常。全宽是当时找到的最简可用方案。

### 8.3 Hevner 情感分类用规则映射而非模型

情感分类用硬编码的 `if/else` 规则（`pickHevnerIdx`），而不是训练分类器。

**原因**：数据量不足以训练；规则逻辑基于 Russell V/A 坐标区间，可解释、可调整；映射关系参考了音乐心理学文献的典型对应关系。

### 8.4 启动时预加载全部已提取曲目

应用启动时自动 `fetchFeatures` 加载所有 `extracted: true` 的曲目，而不是按需加载。

**原因**：Corpus View 的语料库散点图需要全部曲目数据才能渲染完整，按需加载会导致图上数据点随时间变化，体验不一致。代价是启动时有一批并发请求。

### 8.5 选择 TV 数据集与三位作曲家

数据集由论文合作者通过个人渠道提供，已附带完整的段落时间戳注释（`TV_annotation.xlsx`）。选择 Mozart、Beethoven、Haydn 的原因：TAVERN 数据集已对这三位作曲家的变奏曲提供罗马数字和声标注，是 T&V 领域最常用的量化研究基础。

---

## 九、dev 分支变更摘要

以下为相对于 `main` 分支的全部改动（18 + 3 个 commit）。

### 后端重构

| 改动 | 说明 |
|---|---|
| 引入分层 `app/` 架构 | 拆分为 `api/`（路由层）+ `services/`（业务逻辑层），路由不再含计算逻辑 |
| 删除旧单体 `server.py` | 及所有散落在 `backend/` 根目录的 pipeline 脚本（`extract_features.py` 等）|
| 数据目录迁移 | 所有外部数据迁入 `backend/data/`，路径常量集中在 `core/config.py` |
| 临时文件管理 | `features/temp/` 与永久目录分离；`main.py` 启动时及每小时清理过期临时文件 |
| 删除 `SCORES_DIR` 死码 | 修复 `GET /api/score/musicxml` 路由 |
| 删除 CLI pipeline 入口 | 各 service 模块中不再包含命令行运行逻辑 |
| 删除 ExtractionPanel 端到端 | 前端提取面板 + 后端 `/api/extract` SSE 路由一并移除 |

### 前端重构

| 改动 | 说明 |
|---|---|
| 拆解 `App.tsx` | 状态逻辑提取为 `hooks/`，类型定义迁入 `types/`，目标 < 100 行 |
| i18n 集中化 | 改为 `LangContext` + `translations.ts` 字典，去掉 `lang` prop 层层传递 |
| 目录重组 | 按业务域重新组织为 `features/` + `pages/` |
| 路径别名 | 添加 `@` 别名指向 `src/`，消除相对路径地狱 |
| 死码清理 | knip + tsc 扫描删除未使用导出；ESLint 全部通过 |

### Bug 修复

| 文件 | 问题 |
|---|---|
| `app/api/symbolic.py` | `compute_symbolic_features` 和 `compute_distributions` 被调用但从未 import，有 MXL 文件时 `GET /api/symbolic/` 直接 crash |

### 其他

- Mental Landscape 相关死码端到端清除（`translations.ts` 中 `mental.*` 条目、`UploadModal.tsx` 展示字符串、`upload.py` 中 `available_views` 条目）
- `CLAUDE.md` 删除（内容已整合至本文档）
- `.claude/` 移出 git 追踪

---

### 测试覆盖

| 类型 | 位置 | 用例数 |
|---|---|---|
| 纯函数单元测试 | `tests/test_services/` | 142 |
| API 接口测试 | `tests/test_api/` | 54 |
| **合计** | | **196** |

运行命令：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/ -v
```
