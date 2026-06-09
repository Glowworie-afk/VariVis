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

选择这三位作曲家的原因：TAVERN 数据集已对其变奏曲提供罗马数字和声标注，是 T&V 量化研究领域最常用的基础；Mozart K.265（小星星变奏）作为西方钢琴教学标准曲目，可为评估者提供熟悉的参照基线。

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
