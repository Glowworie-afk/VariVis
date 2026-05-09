"""
build_pitch_prototype.py
========================
Process WAMozart_K265_1 with Basic Pitch (audio → notes),
then generate a self-contained HTML prototype showing:
  - Score MIDI line  (blue)  — from MusicXML, already in JSON
  - Audio line       (orange) — from Basic Pitch transcription

Output: pitch_prototype.html  (open in any browser, no server needed)
"""

import json
import tempfile
import os
import numpy as np
import librosa
import soundfile as sf
from pathlib import Path
from basic_pitch.inference import predict as bp_predict

# ── Config ──────────────────────────────────────────────────────────────────
FILE_NAME  = "WAMozart_K265_1"
FEAT_DIR   = Path(__file__).parent / "features"
AUDIO_DIR  = Path(__file__).parent.parent / "TV_dataset_audio"
OUT_HTML   = Path(__file__).parent.parent / "pitch_prototype.html"

CHROMA_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]

# ── Load feature JSON ────────────────────────────────────────────────────────
with open(FEAT_DIR / f"{FILE_NAME}.json") as f:
    data = json.load(f)

folder = data["metadata"]["folder"]
audio_path = AUDIO_DIR / folder / f"{FILE_NAME}.wav"
print(f"Audio: {audio_path}  exists={audio_path.exists()}")

print("Loading full audio …")
y_full, sr = librosa.load(str(audio_path), sr=22050, mono=True)
print(f"  {len(y_full)/sr:.1f}s  sr={sr}")

# ── Helper: midi → relative (same as backend) ───────────────────────────────
def to_relative(midi_vals, tonic):
    if not midi_vals:
        return []
    arr = np.array(midi_vals, dtype=float)
    med = float(np.nanmedian(arr))
    tonic_ref = round((med - tonic) / 12) * 12 + tonic
    return [round(float(v) - tonic_ref, 2) for v in midi_vals]

# ── Process each segment ─────────────────────────────────────────────────────
segments_out = []

for seg in data["segments"]:
    label     = seg["label"]
    start_sec = seg["start_sec"]
    end_sec   = seg["end_sec"]
    pc        = seg["features"].get("pitch_contour", {})

    # Score line — already computed
    score_rel = pc.get("score_beat_midi_relative", [])
    tonic     = pc.get("score_tonic_semitone", 0)
    tonic_name = pc.get("score_tonic_name", "C")
    is_major   = pc.get("score_is_major", True)

    print(f"\n[{label}]  {start_sec:.1f}s – {end_sec:.1f}s  (score beats={len(score_rel)})", flush=True)

    if not score_rel:
        print("  ⚠ no score data, skipping")
        segments_out.append({
            "label": label, "score": [], "audio": [],
            "tonic_name": tonic_name, "is_major": is_major
        })
        continue

    # ── Extract audio segment ──────────────────────────────────────────────
    s = int(start_sec * sr)
    e = min(int(end_sec * sr), len(y_full))
    y_seg = y_full[s:e]

    # Save to temp wav for Basic Pitch
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    sf.write(tmp_path, y_seg, sr)

    # ── Run Basic Pitch ────────────────────────────────────────────────────
    print("  Running Basic Pitch …", end=" ", flush=True)
    try:
        _, _, note_events = bp_predict(tmp_path)
        print(f"{len(note_events)} notes")
    except Exception as ex:
        print(f"ERROR: {ex}")
        note_events = []
    finally:
        os.unlink(tmp_path)

    # ── Beat-align audio notes ─────────────────────────────────────────────
    # Use librosa beat_track to get beat times in the segment
    try:
        _, beat_frames = librosa.beat.beat_track(y=y_seg, sr=sr, hop_length=512)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=512)
    except Exception:
        # fallback: uniform beats matching score beat count
        beat_times = np.linspace(0, end_sec - start_sec, len(score_rel) + 1)[:-1]

    # Register floor: 40th percentile of audio note pitches
    all_pitches = [n[2] for n in note_events]
    pitch_floor = float(np.percentile(all_pitches, 40)) if all_pitches else 60.0

    # Highest soprano note per beat
    audio_beat_midi = []
    for i, bt in enumerate(beat_times):
        bt_end = beat_times[i+1] if i+1 < len(beat_times) else (end_sec - start_sec + 0.1)
        candidates = [
            n[2] for n in note_events
            if bt <= n[0] < bt_end and n[2] >= pitch_floor
        ]
        if candidates:
            audio_beat_midi.append(float(max(candidates)))
        elif audio_beat_midi:
            audio_beat_midi.append(audio_beat_midi[-1])
        else:
            audio_beat_midi.append(60.0)

    # Convert to relative (same tonic as score)
    audio_rel = to_relative(audio_beat_midi, tonic)
    print(f"  audio beats={len(audio_rel)}  range=[{min(audio_rel):.1f},{max(audio_rel):.1f}]")

    segments_out.append({
        "label":      label,
        "score":      score_rel,
        "audio":      audio_rel,
        "tonic_name": tonic_name,
        "is_major":   is_major,
    })

print("\nAll segments processed. Building HTML …")

# ── Build HTML ────────────────────────────────────────────────────────────────
data_json = json.dumps(segments_out, ensure_ascii=False)

HTML = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Pitch Contour Prototype — WAMozart K.265 (WAMozart_K265_1)</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: 'Segoe UI', system-ui, sans-serif; background: #0f1117; color: #e2e8f0; padding: 20px; }}
  h1 {{ font-size: 15px; font-weight: 600; color: #94a3b8; margin-bottom: 4px; }}
  h2 {{ font-size: 12px; font-weight: 400; color: #64748b; margin-bottom: 20px; }}
  .legend {{ display: flex; gap: 20px; margin-bottom: 16px; font-size: 12px; }}
  .legend-item {{ display: flex; align-items: center; gap: 6px; }}
  .dot {{ width: 24px; height: 3px; border-radius: 2px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }}
  .card {{
    background: #1e2130; border-radius: 8px; padding: 12px;
    border: 1px solid #2d3348;
    cursor: pointer; transition: border-color .15s;
  }}
  .card:hover {{ border-color: #475569; }}
  .card.active {{ border-color: #6366f1; background: #1e2040; }}
  .card-title {{ font-size: 11px; font-weight: 600; color: #94a3b8; margin-bottom: 8px; }}
  .card-key {{ font-size: 10px; color: #64748b; margin-left: 6px; }}
  svg.chart {{ width: 100%; overflow: visible; }}
  #detail {{
    background: #1e2130; border-radius: 8px; padding: 16px;
    border: 1px solid #6366f1; margin-bottom: 16px; display: none;
  }}
  #detail.visible {{ display: block; }}
  #detail h3 {{ font-size: 13px; font-weight: 600; color: #a5b4fc; margin-bottom: 12px; }}
  .stat-row {{ display: flex; gap: 20px; margin-top: 10px; font-size: 11px; color: #64748b; }}
  .stat {{ color: #94a3b8; }}
  .stat span {{ color: #e2e8f0; font-weight: 600; }}
</style>
</head>
<body>
<h1>Score MIDI vs Audio Transcription — Pitch Contour</h1>
<h2>WAMozart K.265 · Performance WAMozart_K265_1 · Basic Pitch (Spotify) transcription</h2>

<div class="legend">
  <div class="legend-item"><div class="dot" style="background:#6366f1"></div>Score MIDI (highest note / beat)</div>
  <div class="legend-item"><div class="dot" style="background:#f59e0b"></div>Audio transcription (Basic Pitch, highest note / beat)</div>
</div>

<div id="detail">
  <h3 id="detail-title"></h3>
  <svg id="detail-svg" class="chart" viewBox="0 0 800 200"></svg>
  <div class="stat-row">
    <div class="stat">Score beats <span id="st-sb"></span></div>
    <div class="stat">Audio beats <span id="st-ab"></span></div>
    <div class="stat">Score range <span id="st-sr"></span></div>
    <div class="stat">Audio range <span id="st-ar"></span></div>
    <div class="stat">Mean |Δ| <span id="st-diff"></span> semitones</div>
  </div>
</div>

<div class="grid" id="grid"></div>

<script>
const SEGMENTS = {data_json};

const Y_MIN = -14, Y_MAX = 20;  // semitone display range

function norm(v, min, max) {{
  return 1 - Math.max(0, Math.min(1, (v - min) / (max - min)));
}}

function makePath(vals, W, H, padX, padY, color, strokeW) {{
  if (!vals || vals.length < 2) return '';
  const w = W - padX*2, h = H - padY*2;
  const pts = vals.map((v, i) => ({{
    x: padX + (i / (vals.length - 1)) * w,
    y: padY + norm(v, Y_MIN, Y_MAX) * h
  }}));
  let d = `M ${{pts[0].x.toFixed(1)}} ${{pts[0].y.toFixed(1)}}`;
  for (let i = 1; i < pts.length; i++) {{
    const p = pts[i-1], c = pts[i], mx = (p.x + c.x)/2;
    d += ` C ${{mx.toFixed(1)}} ${{p.y.toFixed(1)}}, ${{mx.toFixed(1)}} ${{c.y.toFixed(1)}}, ${{c.x.toFixed(1)}} ${{c.y.toFixed(1)}}`;
  }}
  return `<path d="${{d}}" fill="none" stroke="${{color}}" stroke-width="${{strokeW}}" stroke-linejoin="round"/>`;
}}

function makeYAxis(W, H, padX, padY) {{
  const ticks = [Y_MIN, -7, 0, 7, 12, Y_MAX];
  const labels = {{ [Y_MIN]: `${{Y_MIN}}`, '-7': '-7', '0': 'T', '7': 'P5', '12': '8va', [Y_MAX]: `+${{Y_MAX}}` }};
  return ticks.map(v => {{
    const y = padY + norm(v, Y_MIN, Y_MAX) * (H - padY*2);
    const isZero = v === 0;
    return `
      <line x1="${{padX}}" y1="${{y.toFixed(1)}}" x2="${{W - padX/2}}" y2="${{y.toFixed(1)}}"
        stroke="${{isZero ? '#475569' : '#2d3348'}}" stroke-width="${{isZero ? 1.2 : 0.8}}"
        stroke-dasharray="${{isZero ? '' : '3 3'}}"/>
      <text x="${{padX - 4}}" y="${{(y + 3).toFixed(1)}}" text-anchor="end"
        font-size="8" fill="#64748b">${{labels[v] ?? v}}</text>`;
  }}).join('');
}}

function renderMiniChart(seg) {{
  const W = 320, H = 90, px = 30, py = 10;
  const grid = makeYAxis(W, H, px, py);
  const scorePath = makePath(seg.score, W, H, px, py, '#6366f1', 1.5);
  const audioPath = makePath(seg.audio, W, H, px, py, '#f59e0b', 1.5);
  return `<svg class="chart" viewBox="0 0 ${{W}} ${{H}}">${{grid}}${{scorePath}}${{audioPath}}</svg>`;
}}

function renderDetailChart(seg) {{
  const W = 800, H = 200, px = 36, py = 16;
  const grid = makeYAxis(W, H, px, py);
  const scorePath = makePath(seg.score, W, H, px, py, '#6366f1', 2);
  const audioPath = makePath(seg.audio, W, H, px, py, '#f59e0b', 2);
  return `${{grid}}${{scorePath}}${{audioPath}}`;
}}

function meanAbsDiff(a, b) {{
  if (!a.length || !b.length) return null;
  const n = Math.min(a.length, b.length);
  // resample longer to shorter length
  const resample = (arr, targetLen) => {{
    return Array.from({{length: targetLen}}, (_, i) => {{
      const idx = Math.round(i / (targetLen-1) * (arr.length-1));
      return arr[idx];
    }});
  }};
  const ra = resample(a, n), rb = resample(b, n);
  return (ra.reduce((s, v, i) => s + Math.abs(v - rb[i]), 0) / n).toFixed(2);
}}

let activeIdx = null;

function showDetail(idx) {{
  const seg = SEGMENTS[idx];
  document.getElementById('detail').classList.add('visible');
  document.getElementById('detail-title').textContent =
    `${{seg.label}}  ·  ${{seg.tonic_name}}${{seg.is_major ? ' major' : ' minor'}}`;
  document.getElementById('detail-svg').innerHTML = renderDetailChart(seg);
  document.getElementById('st-sb').textContent = seg.score.length;
  document.getElementById('st-ab').textContent = seg.audio.length;
  const sr = seg.score, ar = seg.audio;
  document.getElementById('st-sr').textContent =
    sr.length ? `[${{Math.min(...sr).toFixed(1)}}, ${{Math.max(...sr).toFixed(1)}}]` : '—';
  document.getElementById('st-ar').textContent =
    ar.length ? `[${{Math.min(...ar).toFixed(1)}}, ${{Math.max(...ar).toFixed(1)}}]` : '—';
  document.getElementById('st-diff').textContent = meanAbsDiff(sr, ar) ?? '—';

  document.querySelectorAll('.card').forEach((c, i) => {{
    c.classList.toggle('active', i === idx);
  }});
  document.getElementById('detail').scrollIntoView({{behavior:'smooth', block:'nearest'}});
  activeIdx = idx;
}}

// Build grid
const grid = document.getElementById('grid');
SEGMENTS.forEach((seg, idx) => {{
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-title">
      ${{seg.label}}
      <span class="card-key">${{seg.tonic_name}}${{seg.is_major ? ' maj' : ' min'}}</span>
    </div>
    ${{renderMiniChart(seg)}}
  `;
  card.addEventListener('click', () => showDetail(idx));
  grid.appendChild(card);
}});

// Auto-open Theme
showDetail(0);
</script>
</body>
</html>"""

OUT_HTML.write_text(HTML, encoding="utf-8")
print(f"\n✓ HTML written to: {OUT_HTML}")
print("Open it in any browser.")
