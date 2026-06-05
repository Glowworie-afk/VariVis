"""
app/services/pitch_contour.py
──────────────────────────────
pYIN melody pitch contour extraction + Temperley key detection.

Used by:
  - add_pitch_contour.py  (CLI, calls process_file)
  - api/pieces.py upload path  (calls extract_pitch_contour directly)
"""

import json
from pathlib import Path

import librosa
import numpy as np
from scipy.interpolate import interp1d

from app.core.config import AUDIO_DIR, FEATURE_DIR

CHROMA_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Temperley (2007) key profiles — same values as essentia Key(profile='temperley').
# Improves on Krumhansl-Schmuckler for classical music by raising the minor-third
# weight in minor mode (3→4.5), making major/minor more distinguishable.
TEMPERLEY_MAJOR = np.array([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0])
TEMPERLEY_MINOR = np.array([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0])


# ── Core algorithms ───────────────────────────────────────────────────────────

def detect_key(chroma_chromatic: list) -> dict:
    """
    Temperley (2007) key detection via Pearson correlation with rotated profiles.
    Equivalent to essentia.standard.Key(profile='temperley').
    """
    chroma     = np.array(chroma_chromatic, dtype=float)
    best_r     = -np.inf
    best_tonic = 0
    best_major = True
    for tonic in range(12):
        r_maj = float(np.corrcoef(chroma, np.roll(TEMPERLEY_MAJOR, tonic))[0, 1])
        r_min = float(np.corrcoef(chroma, np.roll(TEMPERLEY_MINOR, tonic))[0, 1])
        if r_maj > best_r:
            best_r, best_tonic, best_major = r_maj, tonic, True
        if r_min > best_r:
            best_r, best_tonic, best_major = r_min, tonic, False
    return {
        "tonic_semitone":  best_tonic,
        "tonic_name":      CHROMA_NAMES[best_tonic],
        "is_major":        best_major,
        "key_correlation": round(best_r, 4),
    }


def _compress_to_n_frames(arr: np.ndarray, n: int = 64) -> list:
    length = len(arr)
    if length == 0:
        return [0.0] * n
    idx = np.linspace(0, length, n + 1, dtype=int)
    return [
        float(np.mean(arr[idx[i]:idx[i + 1]])) if idx[i + 1] > idx[i] else 0.0
        for i in range(n)
    ]


def midi_to_relative(midi_vals: list, tonic_semitone: int) -> list:
    """Convert absolute MIDI values to semitones relative to the nearest tonic octave."""
    if not midi_vals:
        return []
    arr       = np.array(midi_vals, dtype=float)
    med       = float(np.nanmedian(arr))
    tonic_ref = round((med - tonic_semitone) / 12) * 12 + tonic_semitone
    return [round(v - tonic_ref, 2) for v in midi_vals]


def beat_align(f0_filled: np.ndarray, voiced_flag: np.ndarray,
               midi_contour: np.ndarray, y: np.ndarray, sr: int) -> list:
    """Sample one representative MIDI value per beat (median of voiced frames)."""
    hop         = 512
    frame_times = librosa.frames_to_time(np.arange(len(f0_filled)), sr=sr, hop_length=hop)
    try:
        _, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
        beat_times     = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    except Exception:
        beat_times = np.linspace(0, frame_times[-1], 17)[:-1]

    result = []
    for i, t_start in enumerate(beat_times):
        t_end        = beat_times[i + 1] if i + 1 < len(beat_times) else frame_times[-1] + 0.01
        mask_voiced  = (frame_times >= t_start) & (frame_times < t_end) & voiced_flag & ~np.isnan(midi_contour)
        if mask_voiced.sum() > 0:
            result.append(float(np.median(midi_contour[mask_voiced])))
            continue
        mask_all  = (frame_times >= t_start) & (frame_times < t_end)
        valid     = midi_contour[mask_all]
        valid     = valid[~np.isnan(valid)]
        if len(valid) > 0:
            result.append(float(np.median(valid)))
        elif result:
            result.append(result[-1])
        else:
            result.append(60.0)
    return result


def extract_pitch_contour(y: np.ndarray, sr: int,
                           chroma_chromatic: list,
                           n_frames: int = 64) -> dict:
    """
    Full pipeline: pYIN → Temperley key detection → beat alignment → relativisation.

    Returns a dict written into segment.features.pitch_contour.
    """
    f0, voiced_flag, _ = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C3"),
        fmax=librosa.note_to_hz("C7"),
        frame_length=2048,
        hop_length=512,
        sr=sr,
    )
    voiced_ratio = float(np.sum(voiced_flag) / max(len(voiced_flag), 1))

    valid_mask = voiced_flag & ~np.isnan(f0)
    if valid_mask.sum() >= 4:
        t_idx     = np.arange(len(f0))
        f0_filled = interp1d(
            t_idx[valid_mask], f0[valid_mask],
            kind="linear", fill_value="extrapolate", bounds_error=False,
        )(t_idx)
    else:
        f0_filled = np.full(max(len(f0), n_frames), 261.63)

    midi_contour        = 69.0 + 12.0 * np.log2(np.maximum(f0_filled, 1.0) / 440.0)
    key_info            = detect_key(chroma_chromatic)
    tonic               = key_info["tonic_semitone"]
    midi_comp           = _compress_to_n_frames(midi_contour, n_frames)
    beat_midi_abs       = beat_align(f0_filled, voiced_flag, midi_contour, y, sr)

    return {
        "n_frames":           n_frames,
        "midi":               midi_comp,
        "midi_relative":      midi_to_relative(midi_comp, tonic),
        "beat_midi":          beat_midi_abs,
        "beat_midi_relative": midi_to_relative(beat_midi_abs, tonic),
        "voiced_ratio":       round(voiced_ratio, 3),
        **key_info,
    }


# ── Dataset pipeline ──────────────────────────────────────────────────────────

def process_file(file_name: str):
    """Add pYIN pitch contour to an existing features JSON in-place."""
    json_path = FEATURE_DIR / f"{file_name}.json"
    if not json_path.exists():
        print(f"✗ JSON not found: {json_path}")
        return

    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    folder   = data["metadata"]["folder"]
    sr_orig  = data["metadata"].get("sample_rate")
    wav_path = AUDIO_DIR / folder / f"{file_name}.wav"
    if not wav_path.exists():
        print(f"✗ WAV not found: {wav_path}")
        return

    print(f"\n{file_name}: loading WAV…")
    y_full, sr = librosa.load(str(wav_path), sr=sr_orig, mono=True)
    n_frames   = data["metadata"].get("compressed_frames", 64)

    for seg in data["segments"]:
        label, start_sec, end_sec = seg["label"], seg["start_sec"], seg["end_sec"]
        print(f"  {label:4s} {start_sec:.1f}s–{end_sec:.1f}s … ", end="", flush=True)
        s     = int(start_sec * sr)
        e     = min(int(end_sec * sr), len(y_full))
        y_seg = y_full[s:e]
        chroma = seg["features"].get("chroma_chromatic", [0.0] * 12)
        try:
            pc = extract_pitch_contour(y_seg, sr, chroma, n_frames)
            seg["features"]["pitch_contour"] = pc
            print(
                f"key={pc['tonic_name']}{'maj' if pc['is_major'] else 'min'} "
                f"r={pc['key_correlation']:.2f}  voiced={pc['voiced_ratio']:.2f}  "
                f"beats={len(pc['beat_midi'])} ✓"
            )
        except Exception as ex:
            seg["features"]["pitch_contour"] = {
                "n_frames": n_frames, "midi": [], "midi_relative": [],
                "beat_midi": [], "beat_midi_relative": [], "voiced_ratio": 0.0,
                "error": str(ex),
            }
            print(f"error: {ex}")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"✓ saved: {json_path.name}")
