"""
app/services/audio.py
─────────────────────
Segment-level audio feature extraction (chroma, MFCC, RMS, onset,
spectral, Tonnetz, chord recognition, compressed time-series, pYIN).

Used by:
  - api/upload.py  (calls extract_audio_segment)
"""

import librosa
import numpy as np


# ── Music constants ───────────────────────────────────────────────────────────

# Circle-of-fifths order: C G D A E B F# Db Ab Eb Bb F
COF_ORDER    = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
COF_NAMES    = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"]
CHROMA_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# 24 chord templates (12 major + 12 minor), pre-normalised
_CHORD_TEMPLATES = np.zeros((24, 12))
for _r in range(12):
    _CHORD_TEMPLATES[_r,      [_r, (_r + 4) % 12, (_r + 7) % 12]] = 1.0
    _CHORD_TEMPLATES[_r + 12, [_r, (_r + 3) % 12, (_r + 7) % 12]] = 1.0

# ── Utility helpers ───────────────────────────────────────────────────────────

def safe_float(x) -> float:
    if np.isnan(x) or np.isinf(x):
        return 0.0
    return float(x)


def safe_list(arr) -> list:
    return [safe_float(x) for x in arr]


def chroma_to_cof(chroma_chromatic: list) -> list:
    return [chroma_chromatic[i] for i in COF_ORDER]


def dominant_pitch(chroma_chromatic: list) -> dict:
    idx = int(np.argmax(chroma_chromatic))
    return {"name": CHROMA_NAMES[idx], "cof_index": COF_ORDER.index(idx)}


def compress_to_n_frames(signal_1d: np.ndarray, n: int = 64) -> list:
    """Downsample a 1-D feature array to exactly n frames using segment mean."""
    length = len(signal_1d)
    if length == 0:
        return [0.0] * n
    indices = np.linspace(0, length, n + 1, dtype=int)
    return [
        float(np.mean(signal_1d[indices[i]:indices[i + 1]])) if indices[i + 1] > indices[i] else 0.0
        for i in range(n)
    ]


def compress_chroma_to_n_frames(chroma_matrix: np.ndarray, n: int = 64) -> list:
    """Compress (12, T) chroma matrix to (12, n) in circle-of-fifths order."""
    return [compress_to_n_frames(chroma_matrix[pc], n) for pc in COF_ORDER]


# ── Core feature extraction ───────────────────────────────────────────────────

def extract_audio_segment(y: np.ndarray, sr: int, compressed_frames: int = 64) -> dict:
    """Extract a full feature set from a single audio segment."""
    from app.services.pitch_contour import extract_pitch_contour

    feats: dict = {}

    chroma_cqt  = librosa.feature.chroma_cqt(y=y, sr=sr, bins_per_octave=36)
    chroma_mean = np.mean(chroma_cqt, axis=1)
    chroma_norm = chroma_mean / (chroma_mean.sum() + 1e-8)
    feats["chroma_chromatic"] = safe_list(chroma_norm)
    feats["chroma_cof"]       = safe_list(chroma_to_cof(chroma_norm.tolist()))
    dp_pc = int(np.argmax(chroma_norm))
    feats["dominant_pitch"] = {"name": CHROMA_NAMES[dp_pc], "cof_index": COF_ORDER.index(dp_pc)}

    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    feats["mfcc_mean"] = safe_list(np.mean(mfcc, axis=1))
    feats["mfcc_std"]  = safe_list(np.std(mfcc, axis=1))

    rms        = librosa.feature.rms(y=y)[0]
    rms_mean   = float(np.mean(rms))
    rms_max    = float(np.max(rms))
    rms_min_nz = float(np.min(rms[rms > 1e-6])) if np.any(rms > 1e-6) else 1e-6
    feats["rms_mean"]         = safe_float(rms_mean)
    feats["rms_std"]          = safe_float(np.std(rms))
    feats["rms_max"]          = safe_float(rms_max)
    feats["dynamic_range_db"] = safe_float(
        20 * np.log10(rms_max / rms_min_nz) if rms_max > 1e-6 else 0.0
    )

    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    feats["spectral_centroid_mean"] = safe_float(np.mean(centroid))
    feats["spectral_centroid_std"]  = safe_float(np.std(centroid))

    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    duration_sec = len(y) / sr
    feats["onset_density"] = safe_float(len(onset_frames) / duration_sec if duration_sec > 0 else 0)
    if len(onset_frames) >= 3:
        intervals = np.diff(onset_frames)
        mean_ioi  = float(np.mean(intervals))
        cov       = float(np.std(intervals)) / mean_ioi if mean_ioi > 0 else 1.0
        feats["rhythm_regularity"] = safe_float(1.0 / (1.0 + cov))
    else:
        feats["rhythm_regularity"] = 0.5

    try:
        tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
        feats["tempo"] = safe_float(float(np.squeeze(tempo_arr)))
    except Exception:
        feats["tempo"] = 0.0

    try:
        harm = librosa.effects.harmonic(y=y)
        feats["tonnetz_mean"] = safe_list(np.mean(librosa.feature.tonnetz(y=harm, sr=sr), axis=1))
    except Exception:
        feats["tonnetz_mean"] = [0.0] * 6

    try:
        chroma_stft = librosa.feature.chroma_stft(y=y, sr=sr)
        chroma_avg  = np.mean(chroma_stft, axis=1)
        norms = np.linalg.norm(_CHORD_TEMPLATES, axis=1)
        sims  = _CHORD_TEMPLATES @ chroma_avg / (norms * (np.linalg.norm(chroma_avg) + 1e-8) + 1e-8)
        best  = int(np.argmax(sims))
        feats["chord_recognition"] = {
            "root": best % 12, "mode": "major" if best < 12 else "minor",
            "root_name": CHROMA_NAMES[best % 12],
        }
    except Exception:
        feats["chord_recognition"] = {"root": 0, "mode": "major", "root_name": "C"}

    try:
        feats["zcr_mean"]               = safe_float(float(np.mean(librosa.feature.zero_crossing_rate(y=y)[0])))
        feats["spectral_flatness_mean"] = safe_float(float(np.mean(librosa.feature.spectral_flatness(y=y)[0])))
        feats["spectral_contrast_mean"] = safe_list(np.mean(librosa.feature.spectral_contrast(y=y, sr=sr), axis=1))
    except Exception:
        feats["zcr_mean"] = feats["spectral_flatness_mean"] = 0.0
        feats["spectral_contrast_mean"] = [0.0] * 7

    n = compressed_frames
    onset_comp = [0] * n
    if duration_sec > 0:
        for t in onset_frames:
            idx = int(t / duration_sec * n)
            if 0 <= idx < n:
                onset_comp[idx] += 1

    def _downsample(arr_1d, target):
        arr = np.array(arr_1d, dtype=float)
        if len(arr) == 0:
            return [0.0] * target
        indices = np.linspace(0, len(arr) - 1, target).astype(int)
        return safe_list(arr[indices])

    feats["compressed"] = {
        "n_frames":          n,
        "rms":               _downsample(rms, n),
        "spectral_centroid": _downsample(centroid, n),
        "chroma_cof":        [_downsample(chroma_cqt[pc], n) for pc in COF_ORDER],
        "onset_count":       onset_comp,
    }

    try:
        chroma_chromatic = feats.get("chroma_chromatic", [0.0] * 12)
        feats["pitch_contour"] = extract_pitch_contour(y, sr, chroma_chromatic, n)
    except Exception as e:
        print(f"  [upload] pitch_contour failed: {e}")
        feats["pitch_contour"] = {"beat_midi": [], "midi_relative": [], "n_frames": n, "midi": []}

    return feats

