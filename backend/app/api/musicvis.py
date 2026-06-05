"""
app/api/musicvis.py
────────────────────
Routes: MusicXML visualization (sections, chords, skeleton, ornaments,
        chord-tones, harmonics, raw XML serving).
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.services.musicvis import (
    COF_NAMES,
    COF_ORDER,
    build_chord_lookup,
    degree_to_function,
    extract_skeleton_level,
    match_skeleton_in_section,
)
from app.services.musicxml import (
    _SECTION_SKIP,
    extract_mxl,
    find_musicxml,
    get_musicxml_sections,
)

router = APIRouter()


def _load_score(file_name: str):
    """Load score from MusicXML, returning (score, path) or raising HTTPException."""
    path = find_musicxml(file_name)
    if path is None:
        raise HTTPException(404, f"No MusicXML found for {file_name} in MusicXML/")
    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")
    try:
        if path.suffix.lower() == ".mxl":
            score = music21.converter.parseData(extract_mxl(path), format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception as e:
        raise HTTPException(500, f"music21 parse error: {e}")
    return score, path


@router.get("/api/musicvis/list")
def list_musicxml():
    from app.core.config import MUSICXML_DIR
    files = []
    for f in sorted(MUSICXML_DIR.iterdir()):
        if f.suffix.lower() in (".mxl", ".xml", ".musicxml"):
            files.append(f.stem)
    return {"files": files}


@router.get("/api/musicvis/xml/{file_name}")
def serve_musicxml_raw(file_name: str):
    path = find_musicxml(file_name)
    if path is None:
        raise HTTPException(404, f"No MusicXML found for {file_name} in MusicXML/")
    if path.suffix.lower() == ".mxl":
        return Response(content=extract_mxl(path), media_type="text/xml")
    return Response(content=path.read_bytes(), media_type="text/xml")


@router.get("/api/musicvis/sections/{file_name}")
def get_sections(file_name: str):
    """Return section boundaries (Theme, Var. I, …) as global 0-based measure indices."""
    score, path = _load_score(file_name)

    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    if not score.parts:
        return {"sections": []}

    part     = score.parts[0]
    measures = list(part.getElementsByClass("Measure"))
    total    = len(measures)

    offset_to_idx: dict[float, int] = {}
    for idx, m in enumerate(measures):
        off = float(m.offset)
        if off not in offset_to_idx:
            offset_to_idx[off] = idx

    raw_sections: list[tuple[float, str]] = []
    seen_offsets: set[float] = set()
    for m in measures:
        off = float(m.offset)
        if off in seen_offsets:
            continue
        seen_offsets.add(off)
        for el in m.flatten():
            if isinstance(el, (music21.expressions.RehearsalMark,
                                music21.expressions.TextExpression)):
                content = (el.content if hasattr(el, "content") else str(el)).strip()
                if not content:
                    continue
                low = content.lower()
                if any(k in low for k in _SECTION_SKIP):
                    continue
                if low.startswith(("tema", "var", "theme", "coda",
                                   "finale", "minore", "maggiore", "trio")):
                    raw_sections.append((off, content))
                    break

    raw_sections.sort(key=lambda x: x[0])
    if raw_sections and offset_to_idx.get(raw_sections[0][0], 0) > 0:
        raw_sections.insert(0, (0.0, "Tema"))

    sections = []
    for i, (off, label) in enumerate(raw_sections):
        start_idx = offset_to_idx.get(off, 0)
        if i + 1 < len(raw_sections):
            end_idx = offset_to_idx.get(raw_sections[i + 1][0], total)
        else:
            end_idx = total
        sections.append({"label": label, "norm": label,
                          "start_idx": start_idx, "end_idx": end_idx})

    return {"matched": True, "file_name": file_name,
            "sections": sections, "total_measures": total}


@router.get("/api/musicvis/chords/{file_name}")
def get_chords(file_name: str):
    """Parse MusicXML, chordify per measure, classify into T/S/D/O."""
    score, _ = _load_score(file_name)

    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    try:
        key_obj = score.analyze('key')
    except Exception:
        key_obj = music21.key.Key('C')

    try:
        chordified = score.chordify()
    except Exception as e:
        raise HTTPException(500, f"chordify error: {e}")

    results = []
    for seq_idx, measure in enumerate(chordified.getElementsByClass("Measure")):
        weights: dict[str, float] = {'T': 0.0, 'S': 0.0, 'D': 0.0, 'O': 0.0}
        best_chord, best_dur = '?', 0.0

        for c in measure.getElementsByClass('Chord'):
            dur = float(c.duration.quarterLength)
            if dur < 0.25:
                continue
            try:
                rn  = music21.roman.romanNumeralFromChord(c, key_obj)
                fn  = degree_to_function(rn.scaleDegree)
                lbl = rn.figure
            except Exception:
                fn, lbl = 'O', '?'

            weights[fn] += dur
            if dur > best_dur:
                best_dur, best_chord = dur, lbl

        total      = sum(weights.values()) or 1.0
        dominant_fn = max(weights, key=weights.get)
        results.append({
            "seq":      seq_idx,
            "function": dominant_fn,
            "chord":    best_chord,
            "T": round(weights['T'] / total, 3),
            "S": round(weights['S'] / total, 3),
            "D": round(weights['D'] / total, 3),
            "O": round(weights['O'] / total, 3),
        })

    return {"matched": True, "key": str(key_obj), "mode": key_obj.mode,
            "tonic": key_obj.tonic.name, "measures": results, "total": len(results)}


@router.get("/api/musicvis/skeleton/{file_name}")
def get_skeleton(file_name: str):
    """Extract skeleton melody from Tema, locate matching tones in variations."""
    score, _ = _load_score(file_name)

    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    sections_resp = get_sections(file_name)
    sections = sections_resp.get("sections", []) if isinstance(sections_resp, dict) else []
    if not sections:
        raise HTTPException(404, "No sections found for this file")

    tema = next(
        (s for s in sections if s['label'].lower() in ('tema', 'theme')),
        sections[0],
    )

    try:
        key_obj = score.analyze('key')
    except Exception:
        key_obj = music21.key.Key('C')

    skeleton_fg = extract_skeleton_level(score, tema['start_idx'], tema['end_idx'], key_obj,
                                         min_metric_weight=0.0, max_measure_span=2)
    skeleton_mg = extract_skeleton_level(score, tema['start_idx'], tema['end_idx'], key_obj,
                                         min_metric_weight=2.0, max_measure_span=4)
    skeleton_bg = extract_skeleton_level(score, tema['start_idx'], tema['end_idx'], key_obj,
                                         min_metric_weight=4.0, max_measure_span=8)

    def _build_highlights(skeleton: list) -> dict:
        highlights: dict = {}
        for n in skeleton:
            abs_idx = str(tema['start_idx'] + n['measure_rel'])
            highlights.setdefault(abs_idx, []).append(
                {'beat': n['beat'], 'pc': n['pc'], 'midi': n['midi']}
            )
        for sec in sections:
            if sec['label'] == tema['label']:
                continue
            low = sec['label'].lower()
            if not (low.startswith('var') or low.startswith('theme')
                    or low.startswith('tema')):
                continue
            var_hl = match_skeleton_in_section(
                skeleton, score, sec['start_idx'], sec['end_idx']
            )
            for abs_idx, notes in var_hl.items():
                highlights.setdefault(str(abs_idx), []).extend(notes)
        return highlights

    return {
        "matched":               True,
        "key":                   str(key_obj),
        "skeleton":              skeleton_fg,
        "highlights":            _build_highlights(skeleton_fg),
        "midground_highlights":  _build_highlights(skeleton_mg),
        "background_highlights": _build_highlights(skeleton_bg),
        "tema":                  tema,
        "sections":              sections,
    }


@router.get("/api/musicvis/ornaments/{file_name}")
def get_ornaments(file_name: str):
    """Extract grace notes and notated ornaments from MusicXML."""
    score, _ = _load_score(file_name)

    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    ORNAMENT_TYPES = (
        music21.expressions.Trill,
        music21.expressions.Mordent,
        music21.expressions.InvertedMordent,
        music21.expressions.Turn,
        music21.expressions.InvertedTurn,
        music21.expressions.Tremolo,
    )

    highlights: dict = {}
    total = 0

    for part in score.parts:
        for abs_idx, m in enumerate(part.getElementsByClass('Measure')):
            for el in m.recurse().getElementsByClass(['Note', 'Chord']):
                beat        = float(el.offset)
                is_ornament = el.duration.isGrace

                if not is_ornament:
                    for expr in el.expressions:
                        if isinstance(expr, ORNAMENT_TYPES):
                            is_ornament = True
                            break

                if not is_ornament:
                    continue

                key = str(abs_idx)
                if hasattr(el, 'pitch'):
                    highlights.setdefault(key, []).append(
                        {'beat': beat, 'pc': el.pitch.midi % 12, 'midi': el.pitch.midi}
                    )
                    total += 1
                elif hasattr(el, 'pitches'):
                    for p in el.pitches:
                        highlights.setdefault(key, []).append(
                            {'beat': beat, 'pc': p.midi % 12, 'midi': p.midi}
                        )
                    total += 1

    return {"matched": True, "highlights": highlights, "total": total}


@router.get("/api/musicvis/chordtones/{file_name}")
def get_chordtones(file_name: str):
    """Classify every note as chord tone or non-chord tone."""
    score, _ = _load_score(file_name)

    try:
        import music21
    except ImportError:
        raise HTTPException(500, "music21 not installed")

    try:
        chordified = score.chordify()
    except Exception as e:
        raise HTTPException(500, f"chordify failed: {e}")

    chord_lookup: list[tuple[float, frozenset]] = []
    try:
        cf_flat = chordified.flatten()
        for el in cf_flat.getElementsByClass('Chord'):
            chord_lookup.append((float(el.offset), frozenset(p.midi % 12 for p in el.pitches)))
    except Exception:
        pass
    chord_lookup.sort(key=lambda x: x[0])

    def active_pcs_at(abs_offset: float) -> frozenset:
        pcs: frozenset = frozenset()
        for b, p in chord_lookup:
            if b <= abs_offset + 0.02:
                pcs = p
            else:
                break
        return pcs

    highlights: dict = {}
    total = n_chord = n_non = 0

    for part in score.parts:
        for abs_idx, m in enumerate(part.getElementsByClass('Measure')):
            m_offset = float(m.offset)
            for el in m.recurse().getElementsByClass(['Note', 'Chord']):
                if el.duration.isGrace:
                    continue
                beat         = float(el.offset)
                abs_note_off = m_offset + beat
                pcs_now      = active_pcs_at(abs_note_off)
                key_str      = str(abs_idx)

                def _add(midi_val: int, _beat=beat, _key=key_str, _pcs=pcs_now) -> None:
                    nonlocal total, n_chord, n_non
                    pc = midi_val % 12
                    ct = pc in _pcs
                    highlights.setdefault(_key, []).append(
                        {'beat': _beat, 'pc': pc, 'midi': midi_val, 'chord_tone': ct}
                    )
                    total += 1
                    if ct:
                        n_chord += 1
                    else:
                        n_non += 1

                if hasattr(el, 'pitch'):
                    _add(el.pitch.midi)
                elif hasattr(el, 'pitches'):
                    for p in el.pitches:
                        _add(p.midi)

    return {
        "matched":    True,
        "highlights": highlights,
        "stats": {
            "total":           total,
            "chord_tones":     n_chord,
            "non_chord_tones": n_non,
            "nct_ratio":       round(n_non / total, 3) if total else 0,
        },
    }


@router.get("/api/musicvis/harmonics/{file_name}")
def get_harmonics(file_name: str):
    """Return per-measure harmonic analysis (chroma in COF order)."""
    score, _ = _load_score(file_name)

    parts = score.parts
    if not parts:
        raise HTTPException(500, "No parts found in score")

    all_measures_by_num: dict[int, list] = {}
    for part in parts:
        for m in part.getElementsByClass("Measure"):
            mnum = m.measureNumber
            if mnum not in all_measures_by_num:
                all_measures_by_num[mnum] = []
            for el in m.recurse().notesAndRests:
                if hasattr(el, "pitch"):
                    all_measures_by_num[mnum].append(el.pitch.midi % 12)
                elif hasattr(el, "pitches"):
                    for p in el.pitches:
                        all_measures_by_num[mnum].append(p.midi % 12)

    measures_data = []
    for mnum in sorted(all_measures_by_num.keys()):
        pcs    = all_measures_by_num[mnum]
        counts = [0.0] * 12
        for pc in pcs:
            counts[pc] += 1.0
        total      = sum(counts) or 1.0
        norm       = [counts[pc] / total for pc in range(12)]
        chroma_cof = [norm[COF_ORDER[i]] for i in range(12)]
        dominant_pc = max(range(12), key=lambda i: norm[i]) if pcs else 0
        measures_data.append({
            "index":       mnum,
            "chroma_cof":  [round(v, 4) for v in chroma_cof],
            "dominant_pc": dominant_pc,
            "note_count":  len(pcs),
        })

    return {"matched": True, "file_name": file_name,
            "measures": measures_data, "cof_names": COF_NAMES}
