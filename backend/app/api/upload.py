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
import shutil
import tempfile
import uuid
from pathlib import Path

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.core.config import IMSLP_DIR, MUSICXML_DIR, TEMP_FEATURE_DIR
from app.services.audio import COF_NAMES, COF_ORDER, extract_audio_segment
from app.services.pitch_contour import extract_mxl_pitch_contour
from app.services.score_pitch import build_score_contours, label_key
from app.services.symbolic import parse_mxl_symbolic
from app.services.upload import auto_labels, parse_boundaries

try:
    import librosa
except ImportError:
    librosa = None  # type: ignore

router = APIRouter()


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

    boundary_secs = parse_boundaries(boundaries.strip()) if boundaries.strip() else []
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
            labels     = auto_labels(n_segments)

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
                    seg["features"] = extract_audio_segment(audio_segments_y[i], sr_out)
                except Exception as e:
                    print(f"  [upload] Audio feature extraction failed for {lbl}: {e}")
                    seg["features"] = {}

            if not has_audio and mxl_sections is not None:
                pc_list = extract_mxl_pitch_contour(mxl_sections)
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

        out_path = TEMP_FEATURE_DIR / f"{temp_name}.json"
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

    feat_path = TEMP_FEATURE_DIR / f"{temp_name}.json"
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
