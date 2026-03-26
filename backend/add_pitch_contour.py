"""
add_pitch_contour.py
====================
对已有的特征 JSON 文件补充 pYIN 旋律音高轮廓 + 调性检测 + 节拍对齐采样。
不重新提取其他特征。

调性检测算法：Temperley (2007) 轮廓模板 + Pearson 相关
  - 与 essentia.standard.Key(profile='temperley') 使用相同的模板数值
  - Temperley 模板在大调 vs 小调识别上优于原始 Krumhansl-Schmuckler 模板：
    小三度（minor third）权重从 2.68 提升至 4.5，有效区分 C 大调与 C 小调

用法（在 Mac 的 backend/ 目录下，激活 venv 后运行）：
    python add_pitch_contour.py WAMozart_K265_1
    python add_pitch_contour.py --all

输出字段（写入每个 segment.features.pitch_contour）：
    midi            : [64] 均匀压缩的绝对 MIDI 值（保留，供调试）
    midi_relative   : [64] 相对主音的半音数（0=主音，7=五度，12=八度）
    beat_midi       : [N]  每拍一个绝对 MIDI 代表值（N = 实际拍数）
    beat_midi_relative: [N] 每拍一个相对主音半音数
    voiced_ratio    : 有效帧比例（0–1）
    tonic_semitone  : 主音音级（0=C, 1=C#, ..., 11=B）
    tonic_name      : 主音名称，如 "C", "G", "F#"
    is_major        : True=大调，False=小调
    key_correlation : Temperley 相关系数（0–1，越高越可信）
"""

import argparse
import json
from pathlib import Path

import librosa
import numpy as np
from scipy.interpolate import interp1d

BASE_DIR    = Path(__file__).parent.parent
AUDIO_DIR   = BASE_DIR / "TV_dataset_audio"
FEATURE_DIR = Path(__file__).parent / "features"

CHROMA_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# ── Temperley (2007) 调性轮廓模板 ─────────────────────────────────────
# 与 essentia.standard.Key(profile='temperley') 使用完全相同的数值。
#
# 相比原始 Krumhansl-Schmuckler 模板，Temperley 对古典音乐的改进：
#   小调中小三度（minor third, 半音 3）：KS=2.68 → Temperley=4.5
#   小调中大三度（major third, 半音 4）：KS=2.60 → Temperley=2.0
# 这个差距让模板能更清楚地区分 C 大调（大三度 E 突出）
# 和 C 小调（小三度 Eb 突出），解决了 KS 模板误判小调为大调的问题。
#
# 参考：Temperley, D. (2007). Music and Probability. MIT Press.
TEMPERLEY_MAJOR = np.array([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0])
TEMPERLEY_MINOR = np.array([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0])


def detect_key(chroma_chromatic: list) -> dict:
    """
    Temperley (2007) 调性检测，算法等价于 essentia.standard.Key(profile='temperley')。

    原理：把曲段的色度能量分布（12 维）与 12 个大调 + 12 个小调的 Temperley
    模板逐一做皮尔逊相关，相关系数最高的即为检测到的主调。

    Temperley 模板的关键改进（相对 Krumhansl-Schmuckler）：
      · 小调小三度权重 4.5 vs KS 的 2.68 → 小调特征更显著
      · 适合古典钢琴等调性明确的音乐

    参数:
        chroma_chromatic: [12] 半音阶顺序的色度均值（来自已有特征）

    返回:
        tonic_semitone  : 0=C, 1=C#, ..., 11=B
        tonic_name      : "C", "G", "F#" 等
        is_major        : True / False
        key_correlation : Temperley 相关系数（越接近 1 越可信）
    """
    chroma = np.array(chroma_chromatic, dtype=float)

    best_r      = -np.inf
    best_tonic  = 0
    best_major  = True

    for tonic in range(12):
        # 把模板旋转到以 tonic 为起点（半音循环移位）
        rot_major = np.roll(TEMPERLEY_MAJOR, tonic)
        rot_minor = np.roll(TEMPERLEY_MINOR, tonic)

        r_major = float(np.corrcoef(chroma, rot_major)[0, 1])
        r_minor = float(np.corrcoef(chroma, rot_minor)[0, 1])

        if r_major > best_r:
            best_r, best_tonic, best_major = r_major, tonic, True
        if r_minor > best_r:
            best_r, best_tonic, best_major = r_minor, tonic, False

    return {
        "tonic_semitone":  best_tonic,
        "tonic_name":      CHROMA_NAMES[best_tonic],
        "is_major":        best_major,
        "key_correlation": round(best_r, 4),
    }


def compress_to_n_frames(arr: np.ndarray, n: int = 64) -> list:
    """均匀压缩到 n 帧，每段取均值。"""
    length = len(arr)
    if length == 0:
        return [0.0] * n
    idx = np.linspace(0, length, n + 1, dtype=int)
    return [
        float(np.mean(arr[idx[i]:idx[i + 1]])) if idx[i + 1] > idx[i] else 0.0
        for i in range(n)
    ]


def beat_align(f0_voiced: np.ndarray, voiced_flag: np.ndarray,
               midi_contour: np.ndarray, y: np.ndarray, sr: int) -> list:
    """
    节拍对齐采样：每拍取一个 MIDI 代表值（中位数）。

    beat_track 在慢板段可能不稳定，用 try/except 兜底。

    返回: list[float]，长度 = 实际检测到的拍数
    """
    hop = 512
    frame_times = librosa.frames_to_time(np.arange(len(f0_voiced)), sr=sr, hop_length=hop)

    try:
        _, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    except Exception:
        # 退化：均匀分成16拍
        beat_times = np.linspace(0, frame_times[-1], 17)[:-1]

    beat_midi_list = []
    for i, t_start in enumerate(beat_times):
        t_end = beat_times[i + 1] if i + 1 < len(beat_times) else frame_times[-1] + 0.01

        # 优先：有 voiced 标记的帧
        mask_voiced = (frame_times >= t_start) & (frame_times < t_end) & voiced_flag & ~np.isnan(midi_contour)
        if mask_voiced.sum() > 0:
            beat_midi_list.append(float(np.median(midi_contour[mask_voiced])))
            continue

        # 退化：这拍内所有帧的中位数（插值后不含 NaN）
        mask_all = (frame_times >= t_start) & (frame_times < t_end)
        vals = midi_contour[mask_all]
        valid_vals = vals[~np.isnan(vals)]
        if len(valid_vals) > 0:
            beat_midi_list.append(float(np.median(valid_vals)))
        elif beat_midi_list:
            beat_midi_list.append(beat_midi_list[-1])  # 重复上一拍
        else:
            beat_midi_list.append(60.0)  # 最终退化：C4

    return beat_midi_list


def midi_to_relative(midi_vals: list, tonic_semitone: int) -> list:
    """
    绝对 MIDI → 相对主音的半音数。

    做法：找 midi_vals 中位数所在八度的主音 MIDI 值，然后相减。
    例：主音 G（半音 7），中位数 MIDI ≈ 67（G4）→ 参考 = 67
         C4(60) - 67 = -7，G4(67) - 67 = 0，D5(74) - 67 = +7

    这样不论变奏转到什么调，纵轴 0 永远是当前段落的主音，
    +7 是五度，+12 是高八度，-5 是低四度……
    """
    if not midi_vals:
        return []
    arr  = np.array(midi_vals, dtype=float)
    med  = float(np.nanmedian(arr))
    # 找最近的同音级八度作为参考 MIDI（对齐到旋律所在的八度）
    tonic_ref = round((med - tonic_semitone) / 12) * 12 + tonic_semitone
    return [round(v - tonic_ref, 2) for v in midi_vals]


def extract_pitch_contour(y: np.ndarray, sr: int,
                          chroma_chromatic: list,
                          n_frames: int = 64) -> dict:
    """
    完整流程：pYIN → KS 调性检测 → 节拍对齐 → 相对化。
    """
    # ── 1. pYIN 基频提取 ──
    f0, voiced_flag, _ = librosa.pyin(
        y,
        fmin=librosa.note_to_hz('C3'),
        fmax=librosa.note_to_hz('C7'),
        frame_length=2048,
        hop_length=512,
        sr=sr,
    )
    voiced_ratio = float(np.sum(voiced_flag) / max(len(voiced_flag), 1))

    # ── 2. 对无声帧做线性插值（保证轮廓连续，避免空洞） ──
    valid_mask = voiced_flag & ~np.isnan(f0)
    if valid_mask.sum() >= 4:
        t = np.arange(len(f0))
        f_interp = interp1d(
            t[valid_mask], f0[valid_mask],
            kind='linear', fill_value='extrapolate', bounds_error=False
        )
        f0_filled = f_interp(t)
    else:
        f0_filled = np.full(max(len(f0), n_frames), 261.63)

    f0_safe       = np.maximum(f0_filled, 1.0)
    midi_contour  = 69.0 + 12.0 * np.log2(f0_safe / 440.0)

    # ── 3. Temperley 调性检测（等价于 essentia Key, profile='temperley'）──
    key_info = detect_key(chroma_chromatic)
    tonic    = key_info["tonic_semitone"]

    # ── 4. 均匀压缩（64帧） ──
    midi_compressed = compress_to_n_frames(midi_contour, n_frames)
    midi_rel_compressed = midi_to_relative(midi_compressed, tonic)

    # ── 5. 节拍对齐采样 ──
    beat_midi_abs = beat_align(f0_filled, voiced_flag, midi_contour, y, sr)
    beat_midi_rel = midi_to_relative(beat_midi_abs, tonic)

    return {
        "n_frames":            n_frames,
        "midi":                midi_compressed,
        "midi_relative":       midi_rel_compressed,
        "beat_midi":           beat_midi_abs,
        "beat_midi_relative":  beat_midi_rel,
        "voiced_ratio":        round(voiced_ratio, 3),
        **key_info,
    }


def process_file(file_name: str):
    json_path = FEATURE_DIR / f"{file_name}.json"
    if not json_path.exists():
        print(f"✗ JSON 不存在: {json_path}")
        return

    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    folder   = data["metadata"]["folder"]
    sr_orig  = data["metadata"].get("sample_rate", None)
    wav_path = AUDIO_DIR / folder / f"{file_name}.wav"
    if not wav_path.exists():
        print(f"✗ WAV 不存在: {wav_path}")
        return

    print(f"\n{file_name}: 加载 WAV…")
    y_full, sr = librosa.load(str(wav_path), sr=sr_orig, mono=True)
    n_frames   = data["metadata"].get("compressed_frames", 64)

    for seg in data["segments"]:
        label, start_sec, end_sec = seg["label"], seg["start_sec"], seg["end_sec"]
        print(f"  {label:4s} {start_sec:.1f}s–{end_sec:.1f}s … ", end="", flush=True)

        s     = int(start_sec * sr)
        e     = min(int(end_sec * sr), len(y_full))
        y_seg = y_full[s:e]

        # 从已有特征里拿 chroma（不重新算）
        chroma_chromatic = seg["features"].get("chroma_chromatic", [0.0] * 12)

        try:
            pc = extract_pitch_contour(y_seg, sr, chroma_chromatic, n_frames)
            seg["features"]["pitch_contour"] = pc
            print(
                f"key={pc['tonic_name']}{'maj' if pc['is_major'] else 'min'} "
                f"r={pc['key_correlation']:.2f}  "
                f"voiced={pc['voiced_ratio']:.2f}  "
                f"beats={len(pc['beat_midi'])} ✓"
            )
        except Exception as ex:
            seg["features"]["pitch_contour"] = {
                "n_frames": n_frames, "midi": [], "midi_relative": [],
                "beat_midi": [], "beat_midi_relative": [],
                "voiced_ratio": 0.0, "error": str(ex),
            }
            print(f"错误: {ex}")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"✓ 已保存: {json_path}")


def main():
    parser = argparse.ArgumentParser(description="为已有JSON补充pYIN旋律轮廓+KS调性检测+节拍对齐")
    parser.add_argument("target", nargs="?", help="file_name，如 WAMozart_K265_1")
    parser.add_argument("--all", action="store_true", help="处理 features/ 下所有 JSON")
    args = parser.parse_args()

    if args.all:
        for p in sorted(FEATURE_DIR.glob("*.json")):
            process_file(p.stem)
    elif args.target:
        process_file(args.target)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
