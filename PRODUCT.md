# VariVis 产品文档

> 版本：草稿 v0.2 · 2026-06-03  
> 状态：存档补记录，供重构参考

---

## 一、项目概述

### 1.1 一句话定义

VariVis 是一个面向**主题与变奏曲（Theme and Variations）**的交互式可视分析系统，目标用户为音乐分析师/理论研究者（需要定量比较特征差异）和有音乐背景的爱好者（想系统性理解一部作品结构但不熟悉编程工具）。核心功能：同时整合符号乐谱（MusicXML）与音频录音的多维特征，在三个协调视图层中支持跨变奏的比较分析。

### 1.2 技术栈与运行环境

**后端**

| 项目 | 规格 |
|---|---|
| 语言 | Python ≥ 3.10（推荐 3.11） |
| 框架 | FastAPI 0.110+，Uvicorn（ASGI） |
| 核心依赖 | librosa、numpy、scipy（特征提取）；music21（MusicXML 解析）；mido（MIDI）；pandas + openpyxl（读注释表）；pymupdf（PDF 渲染）；python-multipart（文件上传） |
| 启动命令 | `cd backend && source .venv/bin/activate && uvicorn server:app --reload --port 8000` |

**前端**

| 项目 | 规格 |
|---|---|
| 语言 | TypeScript + React 18 |
| 构建工具 | Vite |
| 主要库 | Tone.js（音频）；pako（MXL 解压） |
| 开发启动 | `cd frontend && npm run dev` |
| API 代理 | 开发时 Vite 将 `/api` 代理至 `localhost:8000` |

### 1.3 核心价值与典型使用路径

**核心价值**：将音频/乐谱文件转化为可视化的多维特征，让研究者能够用"看"代替"听"来比较变奏结构——尤其是在段落数量多、版本多时，单靠聆听难以形成系统性认知。

**典型路径 A：分析数据集中的已提取曲目**

```
启动后端 → 打开前端
→ 左侧边栏展开作曲家 → 点击版本号（如 v1）加载曲目
→ 左侧下半部分：Feature Comparison Heatmap 显示 33 项符号特征的 Δz 偏差热图
→ 主区域顶部：Segment Overview 横向缩略图条（每格为一个变奏段落的多边形 glyph）
→ 点击某变奏段落 glyph → 下方切换至对应的 Pitch Contour View / Rhythm Timeline / Similarity Tree
→ 右侧面板：Score（PDF）或切换至 Harmonic Function View（需有 MXL 文件）
```

**典型路径 B：提取尚未处理的曲目**

```
点击版本号 → 主区域显示"未提取"状态 + Extraction Panel（触发按钮）
→ 点击提取 → SSE 实时推送进度（extract → pYIN 两步）
→ 提取完成自动刷新，进入正常分析界面
```

**典型路径 C：上传自定义曲目（临时分析）**

```
点击侧边栏"Upload piece" → 弹窗选择文件
→ 输入段落边界时间戳（音频必填）、曲名
→ 后端处理，返回 available_views
→ 左侧出现临时曲目卡片，主区域显示其可用视图
→ 会话结束前点击 × 删除，后端同步清理临时文件
```

---

## 二、名词解释

### 2.1 音乐领域术语

**Chroma（色度）**
将音频信号按音高类别（C、C#、D…B，共 12 个）累加能量得到的 12 维向量。忽略八度信息，反映音乐的调性倾向。VariVis 中有两种排列顺序：`chroma_chromatic`（半音阶顺序 C→B）和 `chroma_cof`（五度圈顺序，用于热图和雷达图）。

**COF（Circle of Fifths，五度圈）**
将 12 个音按纯五度关系排列成圆圈（C→G→D→A→E→B→F#→Db→Ab→Eb→Bb→F→C）。调性关系越近的音，在圆圈上物理位置越近。VariVis 用五度圈顺序而非半音阶顺序排列色度，是因为这样相邻音具有更强的和声关联性，热图视觉模式更有意义。

**MFCC（Mel-frequency Cepstral Coefficients，梅尔频率倒谱系数）**
描述音色（Timbre）的 13 维特征向量。对人耳感知的频率响应做了非线性变换（Mel 尺度），常用于区分不同乐器或演奏风格。

**Onset（起音）**
音符开始发声的时刻。`onset_density`（每秒起音数）反映演奏密度；`rhythm_regularity` 由起音间隔的变异系数推算，值越高表示节奏越匀称（来源：Yang & Chen 2012 §3.3）。

**pYIN**
一种基于概率 YIN 算法的**基频估计**方法（Mauch & Dixon 2014），用于从音频中提取旋律音高轮廓。输出每帧的 MIDI 音高值，`voiced_ratio` 表示有声帧占比（静音段比例高时该值低）。VariVis 中 pYIN 是音高轮廓的第二优先级来源（见第三节）。

**Spectral Centroid（频谱质心）**
频谱能量的"重心"频率，反映音色明亮度。值越高，声音越明亮（如小提琴高音区）；值越低，声音越暗沉（如大提琴低音区）。

**Tonnetz**
一种表示音高关系的 6 维几何空间，编码纯五度、大三度、小三度三种音程关系。相比色度更能捕捉和声张力的变化，常用于和弦进行分析。

**Hevner 情感模型**
Kate Hevner（1936）提出的音乐情感分类，将情感分为 8 类（Vigorous 雄健、Triumphant 激昂、Agitated 激动、Sprightly 活泼、Joyful 欢快、Serene 宁静、Lyrical 抒情、Melancholic 忧郁）。VariVis 根据唤醒度、效价、明亮度、音高五个维度用规则映射出 Hevner 类别，显示在段落缩略图上。

**Russell V/A（Valence-Arousal 二维情感模型）**
James Russell（1980）提出的环形情感空间，横轴为效价（Valence，负面↔正面），纵轴为唤醒度（Arousal，平静↔激动）。VariVis 将各段落的音频特征映射到该空间，在聚焦视图的右下象限显示。

### 2.2 系统专有概念

**Segment / 段落（T、V1、V2…、C）**
VariVis 将每首变奏曲按结构分段：

| 标签 | 含义 |
|---|---|
| `T` | 主题（Theme） |
| `V1`、`V2`… | 第 1、2…变奏（Variation） |
| `C` | 连接段或尾声（Coda/Connector） |

段落边界由 `TV_annotation.xlsx` 中的时间戳注释提供；对于 MusicXML 文件，也可从排练标记（rehearsal marks）自动推断。C 段在某些分析中被跳过（如音高轮廓提取）。

**available_views**
上传或处理临时曲目时，后端根据实际提供的文件类型决定哪些视图可用，结果存入特征 JSON 的 `metadata.available_views`。下表列出内部字符串标识符及其对应的 UI 视图：

| 内部标识符 | 对应 UI 视图 | 所需文件 |
|---|---|---|
| `"corpus_view"` | Segment Overview + 子 Tab（Pitch / Rhythm / Similarity Tree） | 音频 或 MXL（任一） |
| `"symbolic_heatmap"` | Feature Comparison Heatmap（左侧边栏） | MXL |
| `"harmonic_function"` | Harmonic Function View（右侧面板） | MXL 且 ≥2 段落 |
| `"overview"` | OverviewPage（同心环卡片网格，代码中存在，当前 UI 入口未暴露） | 音频 |
| `"mentallandscape"` | MentalLandscapePage（当前 UI 入口未暴露） | 音频 |

**Temp Piece（临时曲目）**
用户上传但不入库的曲目。文件名以 `temp_` 前缀区分，存储在 `backend/features/`（JSON）、`MusicXML/`（MXL 副本）、`IMSLP/`（PDF）中，前端删除时调用 `DELETE /upload/temp/{name}` 同步清理。

**Compressed Features（64 帧压缩）**
为了统一不同时长段落的热图渲染，将时序特征（RMS、频谱质心、色度）降采样到固定 64 帧。这是 Method B 压缩，与 Method A（等时窗）不同，采样点按段落等比分布。

**COF Order**
VariVis 内部使用的五度圈排列索引：`[0,7,2,9,4,11,6,1,8,3,10,5]`，对应音名 `["C","G","D","A","E","B","F#","Db","Ab","Eb","Bb","F"]`。所有色度相关的数组（`chroma_cof`、热图列）均按此顺序排列。

---

## 三、为什么这么设计（设计决策）

> **说明**：本节记录开发过程中的非显而易见决定，包括当时的推理依据。标注 `【待补充】` 的条目只有作者本人能填写。

### 3.1 为什么选 TV 数据集 / 这三位作曲家

数据集（50 首 T&V 作品，385 个录音）由论文合作者 Jing Zhao（[12] 的作者）通过个人渠道提供，已附带 `TV_annotation.xlsx`（每个录音的主题和变奏段落时间戳）。

选择 Mozart、Beethoven、Haydn 的原因：TAVERN 数据集已对这三位作曲家的变奏曲提供了罗马数字和声标注，是 T&V 领域最常用的量化研究基础。Mozart K.265（小星星变奏）作为西方钢琴教学标准曲目，作为用例分析对象可以为评估者提供熟悉的音乐参照基线。

`【待补充】` — 如果当时有其他选择考量（如覆盖曲目数量、版权、录音质量等），请补充。

### 3.2 音高轮廓的三级优先级

音高轮廓（`pitch_contour`）有三个数据来源，前端和后端都按以下优先级使用：

```
1. score_beat_midi（乐谱 MXL → add_score_pitch.py）   ← 最优先
2. beat_midi / midi_relative（pYIN 音频分析）          ← 次选
3. chroma_cof 推算的主音（仅用于调性，无轮廓序列）      ← 兜底
```

**为什么这个顺序**：乐谱来源是演奏无关的"理想旋律"，不受录音噪音和弹奏偏差影响，最适合跨版本比较（MdaAnalysisPage 明确注释了这一点）。pYIN 是音频实测，反映实际演奏但受录音质量限制。色度推算只能给出调性中心，无法给出时序轮廓，仅作兜底。

**前端体现**：`MdaAnalysisPage` 中 `useScoreMidi` 变量决定用哪一层；`CorpusStyleView` 的缩略图用 `midi_relative` 字段画雷达图，两者消费的字段不同。

### 3.3 主界面以 Segment Overview 为核心

系统主区域固定显示 CorpusStyleView（内部代码名），该组件包含：
- 顶部 Segment Overview 横向缩略图条（多边形 glyph，同时编码色度/响度/起音密度/调性/调式五个维度）
- 下方三个可切换的 Drill-down Tab：Pitch Contour View / Rhythm Timeline View / Similarity Tree

`OverviewPage`（同心环卡片）和 `MentalLandscapePage` 这两个组件在代码中存在，但 `App.tsx` 的 `setActiveTab` 未暴露给用户（在 `PieceSection` 中被赋值为 `_setActiveTab` 而未使用），当前 UI 中没有切换到这两个视图的入口。

`【待补充】` — 这是有意为之（未完成）还是暂时搁置？这两个视图是否计划对用户开放？

### 3.4 Hevner 分类用规则映射而非模型

情感分类用了硬编码的 `if/else` 规则（`pickHevnerIdx` 函数），而不是训练一个分类器。

**原因推测**（代码可见）：数据量不足以训练，规则逻辑基于 Russell V/A 坐标区间，可解释、可调整。规则本身参考了音乐心理学文献的典型映射关系。

`【待补充】` — 如果当时参考了具体文献或有其他考量，请补充。

### 3.5 MusicXML 切换到全宽模式

切换到 Harmonic（MusicXML）模式时，主区域完全隐藏，乐谱面板展开全宽。

**原因**：MusicXML 渲染器（OSMD/VexFlow）需要足够宽度才能正确排版五线谱，在三栏布局中右侧面板宽度不足，会导致符头重叠或换行异常。全宽是当时找到的最简单可用方案。

### 3.6 自动加载所有已提取曲目

应用启动时会自动 `fetchFeatures` 加载所有 `extracted: true` 的曲目，而不是按需加载。

**原因**：Corpus View 的语料库散点图（CorpusStyleView 里的多曲对比视图）需要所有曲目的数据才能渲染完整，按需加载会导致图上数据点随时间变化，体验不一致。代价是启动时有一批并发请求。

VariVis 是一个**钢琴变奏曲分析与可视化工具**，面向音乐研究者（或对音乐分析感兴趣的开发者自己）。

它的核心问题是：**同一首主题的不同变奏，在音乐特征上有什么规律？不同演奏版本之间又有什么差异？**

用户可以：
- 加载数据集中的已提取变奏曲，或上传自己的音频/乐谱文件
- 在多个可视化视图间切换，从不同维度观察音乐特征
- 对比同一作品的不同演奏版本

---

## 二、数据来源

### 内置数据集（TV Dataset）

数据集包含 Beethoven、Mozart、Haydn 三位作曲家的**主题与变奏曲**（Theme and Variations），每首曲目有多个演奏版本。

| 文件命名格式 | 含义 |
|---|---|
| `WAMozart_K265_1` | Mozart，K.265（小星星变奏），演奏版本 1 |
| `LBeethoven_OP34_2` | Beethoven，Op.34，演奏版本 2 |

每首曲目分为若干**段落（Segment）**：T（主题）、V1、V2、V3…（变奏 1、2、3…）、C（尾声/连接）。

### 配套资源

| 目录 | 内容 |
|---|---|
| `TV_dataset_audio/` | WAV 音频文件 |
| `TV_MIDI/` | 对应 MIDI 文件（K编号匹配） |
| `IMSLP/` | PDF 乐谱（来自 IMSLP） |
| `MusicXML/` | MXL 格式乐谱（用于和声分析） |
| `backend/features/` | 已提取的 JSON 特征文件（每曲一个） |

### 用户上传

用户可上传自己的文件（任意组合）：
- 音频文件（WAV/MP3）+ 段落边界时间戳
- MusicXML / .mxl 乐谱文件
- PDF 乐谱

上传后在当前会话内可用，关闭前可删除。

---

## 三、特征提取管线

提取是一次性的离线步骤（也可在 UI 内对单曲触发）。提取结果存为 `backend/features/{file_name}.json`。

### 提取内容

每个**段落**提取以下特征：

**和声 / 调性**
- `chroma_cof`：五度圈顺序的 12 维色度向量（sum ≈ 1）
- `dominant_pitch`：主音名称 + 五度圈位置
- `pitch_contour`：旋律音高轮廓（MIDI 值序列，64帧）；来源优先级：乐谱 MXL > pYIN 算法 > 色度估算

**动态 / 能量**
- `rms_mean / std / max`：均方根能量
- `dynamic_range_db`：动态范围

**音色**
- `mfcc_mean / std`：13维 MFCC
- `spectral_centroid_mean`：频谱质心（明亮度）
- `spectral_contrast_mean`：频谱对比度（7频带）

**节奏**
- `onset_density`：每秒起音数
- `tempo`：BPM（慢速段落不可靠）
- `rhythm_regularity`：节奏规律性（0–1，越高越均匀）

**固定帧压缩（64帧）**
- `compressed.rms`、`compressed.spectral_centroid`、`compressed.chroma_cof`：用于热图渲染

### 涉及脚本

| 脚本 | 作用 |
|---|---|
| `extract_features.py` | 主提取：音频 → 特征 JSON |
| `add_pitch_contour.py` | 追加 pYIN 旋律轮廓 |
| `add_score_pitch.py` | 追加乐谱来源的音高轮廓（最高优先级） |
| `batch_extract.sh` | 批量提取整个数据集 |

> **问题**：这几个脚本目前散落在 `backend/` 根目录，互相有依赖但没有包结构，`server.py` 里用 `importlib` 动态加载 `add_score_pitch.py`，属于技术债务。

---

## 四、用户界面

界面分为三栏：**左侧边栏 / 主区域 / 右侧乐谱面板**。

```
┌─────────────────┬──────────────────────────┬──────────────────┐
│   左侧边栏       │        主区域             │    右侧乐谱面板   │
│                 │                          │                  │
│  曲目树形浏览    │  [当前激活视图]           │  Score (PDF)     │
│  ──────────     │                          │  或              │
│  特征比较热图    │                          │  Harmonic (MXL)  │
└─────────────────┴──────────────────────────┴──────────────────┘
```

### 4.1 左侧边栏

**曲目浏览器**（上半部分）
- 三层树形结构：作曲家 → 曲目 → 演奏版本
- 点击版本号（v1、v2…）加载该版本，支持多曲同时加载
- 绿色 M 徽章表示有 MIDI 文件匹配
- 上传按钮：打开上传弹窗

**特征比较热图 / SymbolicHeatmap**（下半部分）
- 显示当前聚焦曲目的段落×特征矩阵
- 数据来源：MusicXML 符号分析
- 无 MXL 文件时显示"No data source"

### 4.2 主区域视图

主区域有一个"激活曲目"概念：左侧树中点击某版本，它成为焦点，主区域显示该曲的内容。

**Corpus View（默认视图）**

主视图，包含两层：

*段落缩略图条（Mini Glyph Strip）*
- 横向滚动，每格代表一个段落（T、V1、V2…）
- 每格绘制小型五度圈雷达图 + Hevner 情感标签
- 点击选中某段落，下方聚焦视图随之更新
- 提供播放控制（播放、暂停、跳转到该段）

*聚焦视图（2×2 格）*
- 显示选中段落的四个维度：
  - **Chroma Ring**：五度圈上的色度分布，显示调性中心
  - **Pitch Contour**：音高轮廓折线图（64帧）
  - **Rhythm Bubble**：节奏气泡图（起音密度 × 规律性）
  - **Russell V/A**：效价（Valence）× 唤醒度（Arousal）二维情感坐标

也可切换到全段落 Tab 模式（Pitch / Rhythm / MDA 分析）。

**Mental Landscape**
- 全段落展开视图
- 以时间轴方式显示各段落的 Hevner 情感分类、调性、动态变化
- 适合整曲情感走势的鸟瞰

**Symbolic Heatmap（Tab）**
- 同左侧边栏的热图，但在主区域全屏展示

**Overview**
- 段落基础统计表格（时长、BPM、音量、主音等）

### 4.3 右侧乐谱面板

两种模式，顶部按钮切换：

| 模式 | 内容 | 数据来源 |
|---|---|---|
| Score | PDF 乐谱内嵌 iframe | IMSLP 目录 |
| Harmonic | MusicXML 交互式渲染 | MusicXML 目录 |

Harmonic 按钮仅在当前曲目有匹配 MXL 文件时显示。切换到 Harmonic 模式后，主区域隐藏，乐谱面板展开为全宽。

---

## 五、API 接口（Backend）

基础地址：`/api`（开发时由 Vite 代理到 `localhost:8000`）

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/pieces` | 列出所有曲目元信息（读 TV_annotation.xlsx） |
| GET | `/features/{name}` | 返回已提取的特征 JSON；404 = 未提取 |
| GET | `/extract/{name}` | SSE 流：触发提取并实时推送进度 |
| GET | `/audio/{name}` | 返回音频文件（用于播放器） |
| GET | `/score/{name}` | 返回 IMSLP PDF |
| GET | `/midi/{name}` | MIDI 分析（和声、节奏） |
| GET | `/midi/notes/{name}` | MIDI 音符列表（用于钢琴卷帘） |
| GET | `/musicvis/list` | 列出 MusicXML 目录中的文件 |
| POST | `/upload/process` | 上传并处理临时曲目 |
| DELETE | `/upload/temp/{name}` | 删除临时上传文件 |

---

## 六、当前已知问题与技术债务

| 问题 | 位置 | 影响 |
|---|---|---|
| `App.tsx` 超过 700 行，包含布局、状态管理、组件定义、工具函数 | `frontend/src/App.tsx` | 难以维护和测试 |
| 提取脚本散落在 `backend/` 根目录 | `extract_features.py` 等 | 没有包结构，server 用 importlib 动态加载 |
| `pieceHeaderBar` 在 `PieceSection` 里重复渲染了两次（corpus_view 和其他 tab 各一套） | `App.tsx` | 代码冗余 |
| `lang` 状态在 App 里始终是 `'en'`，`_setLang` 没有暴露给用户 | `App.tsx` | 多语言功能半实现 |
| 路径常量（AUDIO_DIR、IMSLP_DIR 等）和 API 路由混在 `server.py` 顶部 | `backend/server.py` | 重构时应提取到 `core/paths.py` |
| 上传功能里调用了 `importlib.util` 动态加载 `add_score_pitch.py` | `server.py` `/upload/process` | 脆弱，应改为正常 import |

---

## 七、重构计划（参考 CLAUDE.md）

### Frontend

```
frontend/src/
├── App.tsx                    # 只做布局组合（目标 < 100 行）
├── hooks/
│   ├── usePieceManager.ts     # loadPiece / removePiece / loadedPieces 状态
│   └── useUpload.ts           # 上传流程状态
├── utils/
│   └── pieceDisplay.ts        # shortName / catalogNum / pieceTitle / pieceColor 等纯函数
├── components/
│   ├── PieceBrowserSidebar.tsx # 曲目树形浏览
│   ├── PieceSection.tsx        # 单曲视图容器（已有，从 App 独立）
│   └── ...
└── api/
    └── pieceApi.ts             # 不变
```

### Backend

```
backend/
├── server.py                  # 只做 app 初始化 + router 注册
├── core/
│   └── paths.py               # 所有路径常量
├── routers/
│   ├── pieces.py              # /api/pieces, /api/features
│   ├── extract.py             # /api/extract SSE
│   ├── upload.py              # /api/upload/*
│   ├── audio.py               # /api/audio, /api/score
│   └── musicvis.py            # /api/musicvis/*, /api/midi/*
└── pipeline/
    ├── __init__.py
    ├── extract_features.py
    ├── add_pitch_contour.py
    └── add_score_pitch.py
```

---

*本文档基于代码逆向整理，可能有遗漏或理解偏差。重构过程中请同步修正。*
