"""
VariVis Feature Extraction Pipeline
====================================
从完整WAV录音中按annotation的boundary时间戳切段，
对每段提取音乐特征，输出为JSON供前端可视化使用。

用法:
    python extract_features.py WAMozart_K265_1
    python extract_features.py ARubinstein_OP88_1
    python extract_features.py --all   # 处理annotation中所有有效条目

输出: backend/features/<file_name>.json
"""

import argparse
import ast
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import librosa
import numpy as np
import pandas as pd

# ─────────────────────────────────────────────
# 路径配置（相对于本脚本所在的 backend/ 目录）
# ─────────────────────────────────────────────
BASE_DIR    = Path(__file__).parent.parent          # VariVis/
AUDIO_DIR   = BASE_DIR / "TV_dataset_audio"
DATA_DIR    = Path(__file__).parent / "data"
FEATURE_DIR = Path(__file__).parent / "features"
ANNOTATION  = DATA_DIR / "TV_annotation.xlsx"

FEATURE_DIR.mkdir(exist_ok=True)

# ─────────────────────────────────────────────
# 五度圈音级顺序（色度环排列用）
# 标准色度索引: C=0, C#=1, D=2, ..., B=11
# 五度圈顺序:   C  G  D  A  E  B  F# Db Ab Eb Bb F
# ─────────────────────────────────────────────
COF_ORDER  = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
COF_NAMES  = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"]

# 音级名称（色度标准顺序）
CHROMA_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# ─────────────────────────────────────────────
# 和弦模板（模块级常量，避免重复构造）
# 24个模板：12大调 + 12小调，按半音阶顺序排列（C=0…B=11）
# 大调: root + 大三度(+4) + 纯五度(+7)
# 小调: root + 小三度(+3) + 纯五度(+7)
# ─────────────────────────────────────────────
_CHORD_TEMPLATES = np.zeros((24, 12))
for _r in range(12):
    _CHORD_TEMPLATES[_r,      [_r, (_r + 4) % 12, (_r + 7) % 12]] = 1.0   # major
    _CHORD_TEMPLATES[_r + 12, [_r, (_r + 3) % 12, (_r + 7) % 12]] = 1.0   # minor
# 预计算模板范数（每个模板 = √3，但统一归一化更稳健）
_CHORD_TEMPLATE_NORMS = np.linalg.norm(_CHORD_TEMPLATES, axis=1)  # shape (24,)

# ─────────────────────────────────────────────
# 工具函数
# ─────────────────────────────────────────────

def mmss_to_seconds(value: float) -> float:
    """
    将 MM.SS 格式（如 1.41 = 1分41秒）转为秒数。
    注意：这不是小数分钟，小数部分是秒（两位数）。
    例：0.51 → 51秒，1.41 → 101秒，12.30 → 750秒
    """
    minutes = int(value)
    # 用 round 避免浮点精度问题（如 1.41 存储为 1.4099999...）
    seconds = round((value - minutes) * 100, 1)
    return float(minutes * 60 + seconds)


def parse_list_string(s: str) -> list:
    """
    解析 annotation 里的列表字符串，兼容两种格式：
      - 数值列表（boundary）：'[0.01,0.51,1.41]' → [0.01, 0.51, 1.41]
      - 字符串列表（label）： '[T,V1,V2,C]'      → ['T', 'V1', 'V2', 'C']
    注意：label 列的元素没有引号，ast.literal_eval 无法直接解析，需手动处理。
    """
    s = str(s).strip()
    # 去掉首尾方括号
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    items = [item.strip() for item in s.split(",") if item.strip()]
    result = []
    for item in items:
        try:
            result.append(float(item))
        except ValueError:
            result.append(item)   # 保留为字符串（如 'T', 'V1', 'C'）
    return result


def chroma_to_cof(chroma_chromatic: list) -> list:
    """将色度数组从半音阶顺序重排为五度圈顺序。"""
    return [chroma_chromatic[i] for i in COF_ORDER]


def dominant_pitch(chroma_chromatic: list) -> dict:
    """找色度能量最高的音级，返回音级名和在五度圈中的索引。"""
    idx = int(np.argmax(chroma_chromatic))
    name = CHROMA_NAMES[idx]
    cof_idx = COF_ORDER.index(idx)
    return {"name": name, "cof_index": cof_idx}


def compress_to_n_frames(signal_1d: np.ndarray, n: int = 64) -> list:
    """
    将任意长度的一维特征序列重采样到 n 帧（固定宽度压缩）。
    使用分段均值（比线性插值对音乐特征更稳定）。
    """
    length = len(signal_1d)
    if length == 0:
        return [0.0] * n
    indices = np.linspace(0, length, n + 1, dtype=int)
    compressed = []
    for i in range(n):
        segment = signal_1d[indices[i]:indices[i + 1]]
        compressed.append(float(np.mean(segment)) if len(segment) > 0 else 0.0)
    return compressed


def compress_chroma_to_n_frames(chroma_matrix: np.ndarray, n: int = 64) -> list:
    """
    将 (12, T) 的色度矩阵压缩到 (12, n)，每行独立压缩。
    返回 list[list[float]]，shape = [12][n]，顺序为五度圈。
    """
    result = []
    for pitch_idx in COF_ORDER:
        row = chroma_matrix[pitch_idx]
        result.append(compress_to_n_frames(row, n))
    return result


def safe_float(x) -> float:
    """将 numpy 标量安全转为 Python float。"""
    if np.isnan(x) or np.isinf(x):
        return 0.0
    return float(x)


def safe_list(arr) -> list:
    """将 numpy 数组安全转为 Python list[float]。"""
    return [safe_float(x) for x in arr]


# ─────────────────────────────────────────────
# 核心特征提取
# ─────────────────────────────────────────────

def extract_segment_features(y: np.ndarray, sr: int, label: str, compressed_frames: int = 64) -> dict:
    """
    对单个音频段提取全套特征。

    参数:
        y: 单声道音频数组
        sr: 采样率
        label: 段落标签（如 "T", "V1", ...）
        compressed_frames: 固定宽度压缩的帧数

    返回:
        特征字典，包含聚合统计特征（方案A）和压缩时序特征（方案B）
    """
    features = {}

    # ── 1. 色度特征（CQT，比STFT更适合钢琴频率分辨率）──
    chroma_cqt = librosa.feature.chroma_cqt(y=y, sr=sr, bins_per_octave=36)
    # 聚合：每个音级的平均能量（归一化到 [0,1]）
    chroma_mean = np.mean(chroma_cqt, axis=1)                     # shape (12,)
    chroma_mean_norm = chroma_mean / (chroma_mean.sum() + 1e-8)   # 归一化为比例
    features["chroma_chromatic"]   = safe_list(chroma_mean_norm)
    features["chroma_cof"]         = safe_list(chroma_to_cof(chroma_mean_norm.tolist()))
    features["dominant_pitch"]     = dominant_pitch(chroma_mean_norm.tolist())

    # ── 2. MFCC（音色/音质指纹）──
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    features["mfcc_mean"] = safe_list(np.mean(mfcc, axis=1))
    features["mfcc_std"]  = safe_list(np.std(mfcc, axis=1))

    # ── 3. 动态/能量 ──
    rms = librosa.feature.rms(y=y)[0]
    rms_mean = safe_float(np.mean(rms))
    rms_std  = safe_float(np.std(rms))
    rms_max  = safe_float(np.max(rms))
    # 动态范围（dB），反映力度变化幅度
    rms_min_nonzero = np.min(rms[rms > 1e-6]) if np.any(rms > 1e-6) else 1e-6
    dynamic_range_db = safe_float(
        20 * np.log10(rms_max / rms_min_nonzero) if rms_max > 1e-6 else 0.0
    )
    features["rms_mean"]        = rms_mean
    features["rms_std"]         = rms_std
    features["rms_max"]         = rms_max
    features["dynamic_range_db"] = dynamic_range_db

    # ── 4. 谱质心（音色亮度）──
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    features["spectral_centroid_mean"] = safe_float(np.mean(centroid))
    features["spectral_centroid_std"]  = safe_float(np.std(centroid))

    # ── 5. 节奏：Onset密度 + 速度估计 ──
    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units='time')
    duration_sec = len(y) / sr
    features["onset_density"] = safe_float(len(onset_frames) / duration_sec if duration_sec > 0 else 0)

    # 预先计算起音分桶，供 compressed 使用（每个窗口的真实起音次数）
    def _onset_count_per_frame(onset_times, duration, n_frames):
        if duration <= 0 or n_frames <= 0:
            return [0] * n_frames
        bin_edges = [duration * i / n_frames for i in range(n_frames + 1)]
        counts = [0] * n_frames
        for t in onset_times:
            idx = int(t / duration * n_frames)
            if 0 <= idx < n_frames:
                counts[idx] += 1
        return counts
    try:
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        features["tempo"] = safe_float(float(tempo) if np.ndim(tempo) == 0 else float(tempo[0]))
    except Exception:
        features["tempo"] = 0.0

    # ── 6. 谱对比度（谐波丰富程度，7个频带）──
    spec_contrast = librosa.feature.spectral_contrast(y=y, sr=sr)
    features["spectral_contrast_mean"] = safe_list(np.mean(spec_contrast, axis=1))

    # ── 7. 零交叉率（音色粗糙度）──
    zcr = librosa.feature.zero_crossing_rate(y)[0]
    features["zcr_mean"] = safe_float(np.mean(zcr))

    # ── 8. 谱平坦度（调性 vs 噪声性）──
    flatness = librosa.feature.spectral_flatness(y=y)[0]
    features["spectral_flatness_mean"] = safe_float(np.mean(flatness))

    # ── 9. Tonnetz（调性中心六维特征，适合调性分析）──
    try:
        tonnetz = librosa.feature.tonnetz(y=y, sr=sr)
        features["tonnetz_mean"] = safe_list(np.mean(tonnetz, axis=1))
    except Exception:
        features["tonnetz_mean"] = [0.0] * 6

    # ── 10. 和弦序列识别（基于模板余弦匹配）──
    # 将色度矩阵压缩到 compressed_frames 帧（使用半音阶顺序）
    chroma_comp = np.array([
        compress_to_n_frames(chroma_cqt[i], compressed_frames)
        for i in range(12)
    ])  # shape: (12, compressed_frames), chromatic order

    chord_seq = []
    for _t in range(compressed_frames):
        _frame = chroma_comp[:, _t]
        _fn = float(np.linalg.norm(_frame))
        if _fn < 1e-8:
            chord_seq.append(0)
            continue
        # (24, 12) @ (12,) → (24,), 然后归一化
        _sims = (_CHORD_TEMPLATES @ _frame) / (_fn * _CHORD_TEMPLATE_NORMS)
        chord_seq.append(int(np.argmax(_sims)))

    # 24×24 转换矩阵（记录相邻帧之间的和弦跳转次数）
    _trans = np.zeros((24, 24), dtype=int)
    for _t in range(len(chord_seq) - 1):
        _trans[chord_seq[_t], chord_seq[_t + 1]] += 1

    features["chord_recognition"] = {
        "chord_sequence":    chord_seq,          # list[int], len=64, 0-11=大调, 12-23=小调
        "transition_matrix": _trans.tolist(),     # list[list[int]], 24×24
    }

    # ── 11. 固定宽度压缩（方案B：保留内部走势）──
    features["compressed"] = {
        "n_frames": compressed_frames,
        "rms":              compress_to_n_frames(rms, compressed_frames),
        "spectral_centroid": compress_to_n_frames(centroid, compressed_frames),
        # 色度热力图：按五度圈顺序的 12 x n 矩阵
        "chroma_cof":       compress_chroma_to_n_frames(chroma_cqt, compressed_frames),
        # 每帧真实起音次数（局部节奏密度）：onset_frames 按时间分桶
        "onset_count":      _onset_count_per_frame(onset_frames, duration_sec, compressed_frames),
    }

    # ── 11. 旋律音高轮廓（pYIN）──
    # pYIN 逐帧估计基频（F0），适合单声部旋律（如钢琴高音声部）
    # voiced_ratio: 有效帧比例（接近 1 说明旋律连贯；慢板/和弦段偏低属正常）
    try:
        from scipy.interpolate import interp1d as _interp1d
        f0, voiced_flag, _ = librosa.pyin(
            y,
            fmin=librosa.note_to_hz('C3'),   # ~130 Hz，排除低音声部
            fmax=librosa.note_to_hz('C7'),   # ~2093 Hz
            frame_length=2048,
            hop_length=512,
            sr=sr,
        )
        voiced_ratio = float(np.sum(voiced_flag) / len(voiced_flag)) if len(voiced_flag) > 0 else 0.0

        # 对无声帧（NaN）做线性插值，保证轮廓连续
        valid_mask = voiced_flag & ~np.isnan(f0)
        if valid_mask.sum() >= 4:
            t = np.arange(len(f0))
            f_interp = _interp1d(
                t[valid_mask], f0[valid_mask],
                kind='linear', fill_value='extrapolate', bounds_error=False
            )
            f0_filled = f_interp(t)
        else:
            # 退化：全段用中央C填充（voiced_ratio≈0时前端会用chroma降级）
            f0_filled = np.full(max(len(f0), 64), 261.63)

        # Hz → MIDI 音高值（0–127 浮点）
        f0_safe = np.maximum(f0_filled, 1.0)
        midi_contour = 69.0 + 12.0 * np.log2(f0_safe / 440.0)

        features["pitch_contour"] = {
            "n_frames":     compressed_frames,
            "midi":         compress_to_n_frames(midi_contour, compressed_frames),
            "voiced_ratio": round(voiced_ratio, 3),
        }
    except Exception as e:
        # pYIN 失败时写入空标记，前端会用 chroma 降级渲染
        features["pitch_contour"] = {
            "n_frames":     compressed_frames,
            "midi":         [],
            "voiced_ratio": 0.0,
            "error":        str(e),
        }

    return features


# ─────────────────────────────────────────────
# 主处理流程
# ─────────────────────────────────────────────

def load_annotation() -> pd.DataFrame:
    df = pd.read_excel(ANNOTATION)
    # 向前填充 folder 列（合并单元格的空值）
    df["folder"] = df["folder"].ffill()
    return df


def get_record(df: pd.DataFrame, file_name: str) -> pd.Series:
    """根据 file_name 从 annotation 中取出对应行。"""
    col = "file_name (folderName_number)"
    rows = df[df[col] == file_name]
    if rows.empty:
        raise ValueError(f"找不到记录：{file_name}，请检查 TV_annotation.xlsx 中的 file_name 列")
    return rows.iloc[0]


def process_file(file_name: str, compressed_frames: int = 64, sample_rate: int = None) -> dict:
    """
    完整处理一个录音文件：读 annotation → 加载WAV → 切段 → 提取特征 → 返回字典。

    参数:
        file_name: 如 "WAMozart_K265_1"
        compressed_frames: 固定宽度压缩帧数（默认64）
        sample_rate: 重采样率，None表示保持原始采样率
    """
    print(f"\n{'='*60}")
    print(f"处理: {file_name}")
    print(f"{'='*60}")

    df = load_annotation()
    record = get_record(df, file_name)

    folder = record["folder"]
    wav_path = AUDIO_DIR / folder / f"{file_name}.wav"
    if not wav_path.exists():
        raise FileNotFoundError(f"WAV 文件不存在: {wav_path}")

    # 解析 boundary 和 label
    boundary_raw  = parse_list_string(record["boundary"])
    labels        = parse_list_string(record["label"])
    boundaries_sec = [mmss_to_seconds(b) for b in boundary_raw]

    print(f"曲目: {record['music_name']}")
    print(f"作曲: {record['composer']}")
    print(f"段落: {labels}  ({len(labels)} 段)")
    print(f"边界(秒): {boundaries_sec}")

    # 加载完整 WAV（单声道，保持原始采样率或重采样）
    print(f"\n正在加载 WAV: {wav_path.name}...")
    y_full, sr = librosa.load(str(wav_path), sr=sample_rate, mono=True)
    total_duration = len(y_full) / sr
    print(f"已加载: {total_duration:.1f}s @ {sr}Hz")

    # 检查 boundary 数量与 label 数量是否匹配（boundary应比label多1）
    if len(boundaries_sec) != len(labels) + 1:
        raise ValueError(
            f"boundary数量({len(boundaries_sec)})应等于label数量({len(labels)})+1"
        )

    # 逐段提取特征
    segments = []
    for i, label in enumerate(labels):
        start_sec = boundaries_sec[i]
        end_sec   = boundaries_sec[i + 1]
        duration  = end_sec - start_sec

        print(f"  [{i:2d}] {label:4s}  {start_sec:7.1f}s → {end_sec:7.1f}s  ({duration:.1f}s)", end="")

        # 裁切音频段
        start_sample = int(start_sec * sr)
        end_sample   = min(int(end_sec * sr), len(y_full))
        y_seg = y_full[start_sample:end_sample]

        if len(y_seg) < sr * 0.5:  # 短于0.5秒的段（如极短Coda）给出警告
            print(f"  ⚠ 时长过短({duration:.2f}s)，特征可能不稳定")
        else:
            print()

        feats = extract_segment_features(y_seg, sr, label, compressed_frames)

        segments.append({
            "label":       label,
            "index":       i,
            "start_sec":   round(start_sec, 2),
            "end_sec":     round(end_sec, 2),
            "duration_sec": round(duration, 2),
            "features":    feats,
        })

    # 解析 chord（如果有的话，如 Rubinstein OP88，格式如 '[G major,C minor,...]'）
    chord_info = None
    chord_raw = str(record.get("chord", "")).strip()
    if chord_raw not in ["-", "nan", "", "None"]:
        try:
            chord_info = parse_list_string(chord_raw)
        except Exception:
            chord_info = None

    output = {
        "metadata": {
            "folder":        folder,
            "file_name":     file_name,
            "music_name":    record["music_name"],
            "composer":      record["composer"],
            "period":        record.get("period", ""),
            "instrument":    record.get("instrument", ""),
            "variation_num": int(record.get("variation_num", 0)),
            "chord_annotation": chord_info,
            "sample_rate":   sr,
            "total_duration_sec": round(total_duration, 2),
            "extracted_at":  datetime.now().isoformat(),
            "compressed_frames": compressed_frames,
            "cof_order":     COF_ORDER,
            "cof_names":     COF_NAMES,
        },
        "segments": segments,
    }

    return output


def save_features(data: dict, file_name: str) -> Path:
    out_path = FEATURE_DIR / f"{file_name}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"\n✓ 特征已保存: {out_path}")
    return out_path


# ─────────────────────────────────────────────
# CLI 入口
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="VariVis 音频特征提取")
    parser.add_argument(
        "target",
        nargs="?",
        help="要处理的 file_name，如 WAMozart_K265_1，或 --all 处理全部"
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="处理 TV_annotation.xlsx 中所有有效条目"
    )
    parser.add_argument(
        "--frames",
        type=int,
        default=64,
        help="固定宽度压缩的帧数（默认64）"
    )
    parser.add_argument(
        "--sr",
        type=int,
        default=None,
        help="重采样率，如 22050。默认保持原始采样率"
    )
    args = parser.parse_args()

    if args.all:
        df = load_annotation()
        col = "file_name (folderName_number)"
        targets = df[col].dropna().tolist()
        print(f"共 {len(targets)} 个录音文件待处理")
        success, failed = 0, []
        for t in targets:
            try:
                data = process_file(str(t), args.frames, args.sr)
                save_features(data, str(t))
                success += 1
            except Exception as e:
                print(f"  ✗ {t}: {e}")
                failed.append(str(t))
        print(f"\n完成：{success} 成功，{len(failed)} 失败")
        if failed:
            print("失败列表:", failed)

    elif args.target:
        data = process_file(args.target, args.frames, args.sr)
        save_features(data, args.target)

    else:
        parser.print_help()
        print("\n示例：")
        print("  python extract_features.py WAMozart_K265_1")
        print("  python extract_features.py WAMozart_K265_1 --frames 128")
        print("  python extract_features.py --all")


if __name__ == "__main__":
    main()
