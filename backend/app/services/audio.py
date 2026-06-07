"""
app/services/audio.py
─────────────────────
Segment-level audio feature extraction (chroma, MFCC, RMS, onset,
spectral, Tonnetz, chord recognition, compressed time-series, pYIN).

Used by:
  - api/upload.py  (calls extract_segment_features directly)
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
_CHORD_TEMPLATE_NORMS = np.linalg.norm(_CHORD_TEMPLATES, axis=1)


# ── Utility helpers ───────────────────────────────────────────────────────────

def mmss_to_seconds(value: float) -> float:
    """Convert MM.SS annotation format (e.g. 1.41 = 1 min 41 s) to seconds."""
    minutes = int(value)
    seconds = round((value - minutes) * 100, 1)
    return float(minutes * 60 + seconds)


def parse_list_string(s: str) -> list:
    """Parse an annotation list string like '[0.01,0.51]' or '[T,V1,C]'."""
    s = str(s).strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    items = [item.strip() for item in s.split(",") if item.strip()]
    result = []
    for item in items:
        try:
            result.append(float(item))
        except ValueError:
            result.append(item)
    return result


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

def extract_segment_features(y: np.ndarray, sr: int, label: str, compressed_frames: int = 64) -> dict:
    """
    Extract a full feature set from a single audio segment.

    Returns a dict compatible with the VariVis features JSON schema.
    Pitch contour here is a preliminary compressed pYIN pass; the full
    beat-aligned contour is added later by services/pitch_contour.py.
    """
    features: dict = {}

    # 1. Chroma (CQT — better frequency resolution for piano)
    chroma_cqt      = librosa.feature.chroma_cqt(y=y, sr=sr, bins_per_octave=36)
    chroma_mean      = np.mean(chroma_cqt, axis=1)
    chroma_norm      = chroma_mean / (chroma_mean.sum() + 1e-8)
    features["chroma_chromatic"] = safe_list(chroma_norm)
    features["chroma_cof"]       = safe_list(chroma_to_cof(chroma_norm.tolist()))
    features["dominant_pitch"]   = dominant_pitch(chroma_norm.tolist())

    # 2. MFCC (timbre fingerprint)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    features["mfcc_mean"] = safe_list(np.mean(mfcc, axis=1))
    features["mfcc_std"]  = safe_list(np.std(mfcc, axis=1))

    # 3. Dynamics / energy
    rms              = librosa.feature.rms(y=y)[0]
    rms_mean         = safe_float(np.mean(rms))
    rms_max          = safe_float(np.max(rms))
    rms_min_nz       = float(np.min(rms[rms > 1e-6])) if np.any(rms > 1e-6) else 1e-6
    features["rms_mean"]          = rms_mean
    features["rms_std"]           = safe_float(np.std(rms))
    features["rms_max"]           = rms_max
    features["dynamic_range_db"]  = safe_float(
        20 * np.log10(rms_max / rms_min_nz) if rms_max > 1e-6 else 0.0
    )

    # 4. Spectral centroid (brightness)
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    features["spectral_centroid_mean"] = safe_float(np.mean(centroid))
    features["spectral_centroid_std"]  = safe_float(np.std(centroid))

    # 5. Onset / rhythm
    onset_frames  = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    duration_sec  = len(y) / sr
    features["onset_density"] = safe_float(
        len(onset_frames) / duration_sec if duration_sec > 0 else 0
    )
    if len(onset_frames) >= 3:
        intervals = np.diff(onset_frames)
        mean_ioi  = float(np.mean(intervals))
        cov       = float(np.std(intervals)) / mean_ioi if mean_ioi > 0 else 1.0
        features["rhythm_regularity"] = safe_float(1.0 / (1.0 + cov))
    else:
        features["rhythm_regularity"] = 0.5

    try:
        tempo = librosa.beat.beat_track(y=y, sr=sr)[0]
        features["tempo"] = safe_float(float(tempo) if np.ndim(tempo) == 0 else float(tempo[0]))
    except Exception:
        features["tempo"] = 0.0

    # 6. Spectral contrast (harmonic richness, 7 bands)
    features["spectral_contrast_mean"] = safe_list(
        np.mean(librosa.feature.spectral_contrast(y=y, sr=sr), axis=1)
    )

    # 7. Zero-crossing rate (roughness)
    features["zcr_mean"] = safe_float(np.mean(librosa.feature.zero_crossing_rate(y)[0]))

    # 8. Spectral flatness (tonal vs noisy)
    features["spectral_flatness_mean"] = safe_float(
        np.mean(librosa.feature.spectral_flatness(y=y)[0])
    )

    # 9. Tonnetz (6-D tonal centre)
    try:
        features["tonnetz_mean"] = safe_list(
            np.mean(librosa.feature.tonnetz(y=y, sr=sr), axis=1)
        )
    except Exception:
        features["tonnetz_mean"] = [0.0] * 6

    # 10. Chord recognition (template cosine matching → sequence + transition matrix)
    chroma_comp = np.array([
        compress_to_n_frames(chroma_cqt[i], compressed_frames) for i in range(12)
    ])
    chord_seq = []
    for t in range(compressed_frames):
        frame = chroma_comp[:, t]
        fn    = float(np.linalg.norm(frame))
        if fn < 1e-8:
            chord_seq.append(0)
            continue
        sims = (_CHORD_TEMPLATES @ frame) / (fn * _CHORD_TEMPLATE_NORMS)
        chord_seq.append(int(np.argmax(sims)))
    trans = np.zeros((24, 24), dtype=int)
    for t in range(len(chord_seq) - 1):
        trans[chord_seq[t], chord_seq[t + 1]] += 1
    features["chord_recognition"] = {
        "chord_sequence":    chord_seq,
        "transition_matrix": trans.tolist(),
    }

    # 11. Compressed time-series (fixed-width, n frames)
    def _onset_per_frame(times, dur, n):
        counts = [0] * n
        if dur > 0:
            for t in times:
                idx = int(t / dur * n)
                if 0 <= idx < n:
                    counts[idx] += 1
        return counts

    features["compressed"] = {
        "n_frames":          compressed_frames,
        "rms":               compress_to_n_frames(rms, compressed_frames),
        "spectral_centroid": compress_to_n_frames(centroid, compressed_frames),
        "chroma_cof":        compress_chroma_to_n_frames(chroma_cqt, compressed_frames),
        "onset_count":       _onset_per_frame(onset_frames, duration_sec, compressed_frames),
    }

    # 12. Preliminary pYIN pitch contour (compressed, 64 frames).
    #     The full beat-aligned contour is written by services/pitch_contour.py.
    try:
        from scipy.interpolate import interp1d as _interp1d
        f0, voiced_flag, _ = librosa.pyin(
            y,
            fmin=librosa.note_to_hz("C3"),
            fmax=librosa.note_to_hz("C7"),
            frame_length=2048,
            hop_length=512,
            sr=sr,
        )
        voiced_ratio = float(np.sum(voiced_flag) / len(voiced_flag)) if len(voiced_flag) > 0 else 0.0
        valid_mask   = voiced_flag & ~np.isnan(f0)
        if valid_mask.sum() >= 4:
            t_idx    = np.arange(len(f0))
            f0_filled = _interp1d(
                t_idx[valid_mask], f0[valid_mask],
                kind="linear", fill_value="extrapolate", bounds_error=False,
            )(t_idx)
        else:
            f0_filled = np.full(max(len(f0), 64), 261.63)
        midi_contour = 69.0 + 12.0 * np.log2(np.maximum(f0_filled, 1.0) / 440.0)
        features["pitch_contour"] = {
            "n_frames":     compressed_frames,
            "midi":         compress_to_n_frames(midi_contour, compressed_frames),
            "voiced_ratio": round(voiced_ratio, 3),
        }
    except Exception as e:
        features["pitch_contour"] = {
            "n_frames": compressed_frames, "midi": [], "voiced_ratio": 0.0, "error": str(e),
        }

    return features

