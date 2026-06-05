"""
app/api/upload.py
──────────────────
Routes: process uploaded MusicXML + audio files → temp feature JSON.

Available views by input combination:
  MusicXML only  → symbolic_heatmap, harmonic_function
  Audio only     → overview, mentallandscape, corpus_view
  Both           → all of the above
"""

import json
import math
import shutil
import tempfile
import uuid
from pathlib import Path

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.core.config import FEATURE_DIR, IMSLP_DIR, MUSICXML_DIR
from app.services.pitch_contour import extract_pitch_contour
from app.services.score_pitch import build_score_contours, label_key
from app.services.symbolic import parse_mxl_symbolic

try:
    import librosa
except ImportError:
    librosa = None  # type: ignore

router = APIRouter()

COF_ORDER = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
COF_NAMES = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"]
CHROMA_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _mmss_to_sec(value: float) -> float:
    minutes = int(value)
    seconds = round((value - minutes) * 100, 1)
    return float(minutes * 60 + seconds)


def _parse_boundaries(raw: str) -> list[float]:
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    secs  = []
    for p in parts:
        try:
            secs.append(_mmss_to_sec(float(p)))
        except ValueError:
            pass
    return sorted(secs)


def _auto_labels(n_segments: int) -> list[str]:
    return ["T"] + [f"V{i}" for i in range(1, n_segments)]


def _safe_float(v) -> float:
    try:
        x = float(v)
        return 0.0 if (math.isnan(x) or math.isinf(x)) else x
    except Exception:
        return 0.0


def _safe_list(arr) -> list:
    return [] if arr is None else [_safe_float(x) for x in arr]


def _chroma_to_cof(chroma: list) -> list:
    return [chroma[i] for i in COF_ORDER]


def _extract_audio_segment(y, sr, label: str, compressed_frames: int = 64) -> dict:
    """Full audio feature extraction for one uploaded segment."""
    if librosa is None:
        raise RuntimeError("librosa / numpy not installed")

    feats: dict = {}

    chroma_cqt  = librosa.feature.chroma_cqt(y=y, sr=sr, bins_per_octave=36)
    chroma_mean = np.mean(chroma_cqt, axis=1)
    chroma_norm = chroma_mean / (chroma_mean.sum() + 1e-8)
    feats["chroma_chromatic"] = _safe_list(chroma_norm)
    feats["chroma_cof"]       = _safe_list(_chroma_to_cof(chroma_norm.tolist()))
    dp_pc = int(np.argmax(chroma_norm))
    feats["dominant_pitch"] = {
        "name":      CHROMA_NAMES[dp_pc],
        "cof_index": COF_ORDER.index(dp_pc),
    }

    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    feats["mfcc_mean"] = _safe_list(np.mean(mfcc, axis=1))
    feats["mfcc_std"]  = _safe_list(np.std(mfcc, axis=1))

    rms      = librosa.feature.rms(y=y)[0]
    rms_mean = float(np.mean(rms))
    rms_max  = float(np.max(rms))
    rms_min_nz = float(np.min(rms[rms > 1e-6])) if np.any(rms > 1e-6) else 1e-6
    feats["rms_mean"]         = _safe_float(rms_mean)
    feats["rms_std"]          = _safe_float(np.std(rms))
    feats["rms_max"]          = _safe_float(rms_max)
    feats["dynamic_range_db"] = _safe_float(
        20 * math.log10(rms_max / rms_min_nz) if rms_max > 1e-6 else 0.0
    )

    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    feats["spectral_centroid_mean"] = _safe_float(np.mean(centroid))
    feats["spectral_centroid_std"]  = _safe_float(np.std(centroid))

    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    duration_sec = len(y) / sr
    feats["onset_density"] = _safe_float(
        len(onset_frames) / duration_sec if duration_sec > 0 else 0
    )
    if len(onset_frames) >= 3:
        intervals = np.diff(onset_frames)
        mean_ioi  = float(np.mean(intervals))
        std_ioi   = float(np.std(intervals))
        cov = std_ioi / mean_ioi if mean_ioi > 0 else 1.0
        feats["rhythm_regularity"] = _safe_float(1.0 / (1.0 + cov))
    else:
        feats["rhythm_regularity"] = 0.5

    try:
        tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
        feats["tempo"] = _safe_float(float(np.squeeze(tempo_arr)))
    except Exception:
        feats["tempo"] = 0.0

    try:
        harm = librosa.effects.harmonic(y=y)
        tnet = librosa.feature.tonnetz(y=harm, sr=sr)
        feats["tonnetz_mean"] = _safe_list(np.mean(tnet, axis=1))
    except Exception:
        feats["tonnetz_mean"] = [0.0] * 6

    try:
        chroma_stft = librosa.feature.chroma_stft(y=y, sr=sr)
        chroma_avg  = np.mean(chroma_stft, axis=1)
        templates   = np.zeros((24, 12))
        for r in range(12):
            templates[r,      [r, (r + 4) % 12, (r + 7) % 12]] = 1.0
            templates[r + 12, [r, (r + 3) % 12, (r + 7) % 12]] = 1.0
        norms = np.linalg.norm(templates, axis=1)
        sims  = templates @ chroma_avg / (norms * (np.linalg.norm(chroma_avg) + 1e-8) + 1e-8)
        best  = int(np.argmax(sims))
        root  = best % 12
        mode  = "major" if best < 12 else "minor"
        feats["chord_recognition"] = {"root": root, "mode": mode,
                                       "root_name": CHROMA_NAMES[root]}
    except Exception:
        feats["chord_recognition"] = {"root": 0, "mode": "major", "root_name": "C"}

    try:
        feats["zcr_mean"]               = _safe_float(float(np.mean(librosa.feature.zero_crossing_rate(y=y)[0])))
        feats["spectral_flatness_mean"] = _safe_float(float(np.mean(librosa.feature.spectral_flatness(y=y)[0])))
        sc = librosa.feature.spectral_contrast(y=y, sr=sr)
        feats["spectral_contrast_mean"] = _safe_list(np.mean(sc, axis=1))
    except Exception:
        feats["zcr_mean"]               = 0.0
        feats["spectral_flatness_mean"] = 0.0
        feats["spectral_contrast_mean"] = [0.0] * 7

    n = compressed_frames

    def _downsample(arr_1d, target):
        arr = np.array(arr_1d, dtype=float)
        if len(arr) == 0:
            return [0.0] * target
        indices = np.linspace(0, len(arr) - 1, target).astype(int)
        return _safe_list(arr[indices])

    rms_comp      = _downsample(librosa.feature.rms(y=y)[0], n)
    centroid_comp = _downsample(centroid, n)

    chroma_cof_frames = []
    for pc_idx in COF_ORDER:
        row = chroma_cqt[pc_idx, :]
        chroma_cof_frames.append(_downsample(row, n))

    onset_comp = [0] * n
    if duration_sec > 0:
        for t in onset_frames:
            idx = int(t / duration_sec * n)
            if 0 <= idx < n:
                onset_comp[idx] += 1

    feats["compressed"] = {
        "n_frames":          n,
        "rms":               rms_comp,
        "spectral_centroid": centroid_comp,
        "chroma_cof":        chroma_cof_frames,
        "onset_count":       onset_comp,
    }

    # pYIN pitch contour
    try:
        chroma_chromatic = feats.get("chroma_chromatic", [0.0] * 12)
        feats["pitch_contour"] = extract_pitch_contour(y, sr, chroma_chromatic, n)
    except Exception as _e:
        print(f"  [upload] pitch_contour failed: {_e}")
        feats["pitch_contour"] = {"beat_midi": [], "midi_relative": [],
                                   "n_frames": n, "midi": []}

    return feats


def _extract_mxl_pitch_contour(mxl_sections: list) -> list[dict]:
    """Derive simplified pitch contours from MusicXML note data per section."""
    result = []
    for sec in mxl_sections:
        if sec["label"] == "C":
            continue
        notes = sec["notes_sec"]
        if not notes:
            result.append({"beat_midi": [], "midi_relative": []})
            continue
        pitches = [n["pitch"] for n in sorted(notes, key=lambda x: x["start_sec"])]
        indices = [int(i * (len(pitches) - 1) / 63) for i in range(min(64, len(pitches)))]
        sampled = [pitches[i] for i in indices]
        mean_p  = sum(sampled) / len(sampled)
        result.append({"beat_midi": sampled, "midi_relative": [p - mean_p for p in sampled]})
    return result


@router.post("/api/upload/process")
async def upload_and_process(
    piece_name: str               = Form(...),
    boundaries: str               = Form(""),
    musicxml:   UploadFile | None = File(None),
    audio:      UploadFile | None = File(None),
    pdf:        UploadFile | None = File(None),
):
    has_mxl   = musicxml is not None and musicxml.filename not in (None, "")
    has_audio = audio    is not None and audio.filename    not in (None, "")
    has_pdf   = pdf      is not None and pdf.filename      not in (None, "")

    if not has_mxl and not has_audio:
        raise HTTPException(400, "At least one of musicxml or audio must be provided.")

    boundary_secs = _parse_boundaries(boundaries.strip()) if boundaries.strip() else []
    if has_audio and len(boundary_secs) < 2:
        raise HTTPException(400, "At least 2 boundary timestamps are required when audio is provided.")

    temp_id   = str(uuid.uuid4())[:8]
    temp_name = f"temp_{temp_id}"

    available_views: list[str] = []
    tmp_dir = Path(tempfile.mkdtemp(prefix="varivis_upload_"))

    try:
        mxl_path: "Path | None"   = None
        audio_path: "Path | None" = None

        if has_mxl:
            ext      = Path(musicxml.filename).suffix.lower() or ".mxl"
            mxl_path = tmp_dir / f"score{ext}"
            mxl_path.write_bytes(await musicxml.read())

        if has_audio:
            ext        = Path(audio.filename).suffix.lower() or ".wav"
            audio_path = tmp_dir / f"audio{ext}"
            audio_path.write_bytes(await audio.read())

        tmp_pdf_stem: "str | None" = None
        if has_pdf and pdf is not None:
            pdf_dest     = IMSLP_DIR / f"{temp_name}.pdf"
            pdf_dest.write_bytes(await pdf.read())
            tmp_pdf_stem = temp_name

        segments_out: list[dict]          = []
        mxl_sections: "list[dict] | None" = None

        tmp_mxl_stem: "str | None" = None
        if has_mxl and mxl_path is not None:
            tmp_mxl_stem = temp_name
            dest         = MUSICXML_DIR / f"{tmp_mxl_stem}{mxl_path.suffix}"
            shutil.copy(mxl_path, dest)
            try:
                mxl_sections = parse_mxl_symbolic(tmp_mxl_stem)
            except Exception as e:
                print(f"  [upload] MusicXML parse failed: {e}")
                mxl_sections = None

        if not boundary_secs:
            if mxl_sections is not None and len(mxl_sections) >= 1:
                t = 0.0
                mxl_boundary_secs = [0.0]
                for sec in mxl_sections:
                    t += sec.get("seg_dur_sec", 0.0)
                    mxl_boundary_secs.append(round(t, 3))
                boundary_secs = mxl_boundary_secs
                labels        = [sec["label"] for sec in mxl_sections]
                n_segments    = len(mxl_sections)
            else:
                boundary_secs = [0.0, 1.0]
                labels        = ["T"]
                n_segments    = 1
        else:
            n_segments = len(boundary_secs) - 1
            labels     = _auto_labels(n_segments)

        audio_segments_y: "list | None" = None
        sr_out = 22050
        if has_audio and audio_path is not None:
            if librosa is None:
                raise HTTPException(500, "librosa is not installed on the server.")
            y_full, sr_out = librosa.load(str(audio_path), sr=None, mono=True)
            total_dur      = len(y_full) / sr_out

            boundary_secs_clamped = [min(b, total_dur) for b in boundary_secs]

            audio_segments_y = []
            for i in range(n_segments):
                s = int(boundary_secs_clamped[i] * sr_out)
                e = min(int(boundary_secs_clamped[i + 1] * sr_out), len(y_full))
                audio_segments_y.append(y_full[s:e] if e > s else np.zeros(sr_out // 2))

        for i, lbl in enumerate(labels):
            seg: dict = {
                "label":        lbl,
                "index":        i,
                "start_sec":    round(boundary_secs[i], 2),
                "end_sec":      round(boundary_secs[i + 1], 2) if i + 1 < len(boundary_secs) else round(boundary_secs[-1], 2),
                "duration_sec": round(boundary_secs[i + 1] - boundary_secs[i], 2) if i + 1 < len(boundary_secs) else 0.0,
                "features":     {},
            }

            if audio_segments_y is not None and i < len(audio_segments_y):
                try:
                    seg["features"] = _extract_audio_segment(audio_segments_y[i], sr_out, lbl)
                except Exception as e:
                    print(f"  [upload] Audio feature extraction failed for {lbl}: {e}")
                    seg["features"] = {}

            if not has_audio and mxl_sections is not None:
                pc_list = _extract_mxl_pitch_contour(mxl_sections)
                if i < len(pc_list):
                    seg["features"]["pitch_contour"] = pc_list[i]

            segments_out.append(seg)

        # Score pitch contour from MusicXML (score_beat_midi_relative)
        if has_mxl and tmp_mxl_stem is not None:
            try:
                score_contours = build_score_contours(tmp_mxl_stem)
                if score_contours:
                    for seg in segments_out:
                        lk = label_key(seg["label"])
                        if lk in score_contours:
                            if "pitch_contour" not in seg["features"]:
                                seg["features"]["pitch_contour"] = {}
                            seg["features"]["pitch_contour"].update(score_contours[lk])
                            print(f"  [upload] score pitch → {seg['label']} "
                                  f"beats={len(score_contours[lk].get('score_beat_midi', []))}")
            except Exception as _e:
                print(f"  [upload] score pitch contour failed: {_e}")

        if has_mxl:
            available_views += ["symbolic_heatmap"]
            if mxl_sections is not None and len(mxl_sections) >= 2:
                available_views += ["harmonic_function"]
        if has_audio:
            available_views += ["overview", "mentallandscape"]
        if has_mxl or has_audio:
            available_views.append("corpus_view")

        seen: set[str] = set()
        available_views = [v for v in available_views
                           if v not in seen and not seen.add(v)]  # type: ignore[func-returns-value]

        total_dur_out  = boundary_secs[-1] - boundary_secs[0]
        feature_json: dict = {
            "metadata": {
                "file_name":          temp_name,
                "music_name":         piece_name,
                "composer":           "Uploaded",
                "period":             "",
                "instrument":         "",
                "variation_num":      n_segments - 1,
                "chord_annotation":   None,
                "sample_rate":        sr_out,
                "total_duration_sec": round(total_dur_out, 2),
                "compressed_frames":  64,
                "cof_order":          COF_ORDER,
                "cof_names":          COF_NAMES,
                "is_temp":            True,
                "available_views":    available_views,
                "mxl_stem":           tmp_mxl_stem,
            },
            "segments": segments_out,
        }

        out_path = FEATURE_DIR / f"{temp_name}.json"
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(feature_json, fh, ensure_ascii=False, indent=2)

        return {
            "temp_id":         temp_id,
            "temp_name":       temp_name,
            "music_name":      piece_name,
            "available_views": available_views,
            "mxl_stem":        tmp_mxl_stem,
            "pdf_stem":        tmp_pdf_stem,
            "n_segments":      n_segments,
            "labels":          labels,
        }

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.get("/api/upload/temp_pdf/{temp_name}")
def serve_temp_pdf(temp_name: str):
    if not temp_name.startswith("temp_"):
        raise HTTPException(400, "Invalid temp name.")
    pdf_path = IMSLP_DIR / f"{temp_name}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, f"No PDF found for {temp_name}")
    return FileResponse(str(pdf_path), media_type="application/pdf")


@router.delete("/api/upload/temp/{temp_name}")
def delete_temp_upload(temp_name: str):
    if not temp_name.startswith("temp_"):
        raise HTTPException(400, "Invalid temp name.")

    feat_path = FEATURE_DIR / f"{temp_name}.json"
    if feat_path.exists():
        feat_path.unlink()

    for ext in (".mxl", ".xml", ".musicxml"):
        p = MUSICXML_DIR / f"{temp_name}{ext}"
        if p.exists():
            p.unlink()

    pdf_path = IMSLP_DIR / f"{temp_name}.pdf"
    if pdf_path.exists():
        pdf_path.unlink()

    return {"deleted": temp_name}
