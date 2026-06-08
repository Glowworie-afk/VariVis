"""
app/services/musicvis.py
─────────────────────────
MusicXML score-visualization algorithms:
  - Harmonic function analysis (T/S/D)
  - Skeleton melody extraction (Wang et al., ISMIR 2025)
  - Ornament detection
  - Chord-tone classification
  - Circle-of-fifths harmonics

Used by:
  - api/musicvis.py  (chord/skeleton/ornament/chordtone/harmonics endpoints)
"""

COF_ORDER = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
COF_NAMES = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"]


# ── Harmonic function ─────────────────────────────────────────────────────────

def degree_to_function(degree: int) -> str:
    """Map scale degree 1-7 to harmonic function T/S/D/O."""
    return {1: 'T', 2: 'S', 3: 'T', 4: 'S', 5: 'D', 6: 'T', 7: 'D'}.get(degree, 'O')


# ── Skeleton melody helpers (Wang et al., ISMIR 2025) ────────────────────────

def metric_weight(beat_offset: float, ts_num: int) -> float:
    """Metric weight for a beat offset (in quarter-note units) within a measure."""
    b = beat_offset
    if b == 0.0:
        return 4.0
    half = ts_num / 2.0
    if ts_num >= 4 and abs(b - half) < 0.05:
        return 2.0
    if abs(b - round(b)) < 0.05:
        return 1.0
    return 0.5


def _pc(midi: int) -> int:
    return midi % 12


def step_interval(a: int, b: int) -> bool:
    """True if chromatic interval between two pitch classes is semitone or whole tone."""
    return min((b - a) % 12, (a - b) % 12) in (1, 2)


def extract_top_voice(measures: list, start_idx: int, end_idx: int) -> list:
    """
    Collect highest-sounding pitch at each distinct beat offset within each measure
    for measures[start_idx:end_idx] from the top part.
    Returns list of dicts: {measure_rel, beat, pc, midi, duration, metric_weight}.
    """
    result = []
    for rel, m in enumerate(measures[start_idx:end_idx]):
        ts     = m.getContextByClass('TimeSignature')
        ts_num = ts.numerator if ts else 4

        beat_notes: dict = {}
        for el in m.recurse().notesAndRests:
            beat = float(el.offset)
            dur  = float(el.duration.quarterLength)
            if hasattr(el, 'pitch'):
                beat_notes.setdefault(beat, []).append((el.pitch.midi, dur))
            elif hasattr(el, 'pitches'):
                for p in el.pitches:
                    beat_notes.setdefault(beat, []).append((p.midi, dur))

        for beat in sorted(beat_notes.keys()):
            top_midi, top_dur = max(beat_notes[beat], key=lambda x: x[0])
            result.append({
                'measure_rel':   rel,
                'beat':          beat,
                'pc':            _pc(top_midi),
                'midi':          top_midi,
                'duration':      top_dur,
                'metric_weight': metric_weight(beat, ts_num),
            })
    return result


def remove_ornaments(notes: list) -> list:
    """
    Middleground-level filtering: remove notes that are ALL of:
      - on a very weak beat (metric_weight == 0.5)
      - extremely short (< 0.25 quarter notes)
      - form passing or neighbor motion with neighbours
    """
    if len(notes) < 3:
        return notes
    keep = [True] * len(notes)
    for i in range(1, len(notes) - 1):
        n = notes[i]
        if n['metric_weight'] >= 1.0:
            continue
        if n['duration'] >= 0.25:
            continue
        prev_pc = notes[i - 1]['pc']
        curr_pc = n['pc']
        next_pc = notes[i + 1]['pc']
        step_in  = step_interval(prev_pc, curr_pc)
        step_out = step_interval(curr_pc, next_pc)
        same_dir = (((curr_pc - prev_pc) % 12 < 6) == ((next_pc - curr_pc) % 12 < 6))
        passing  = step_in and step_out and same_dir
        neighbor = step_in and step_out and (prev_pc == next_pc)
        if passing or neighbor:
            keep[i] = False
    return [n for n, k in zip(notes, keep) if k]


def build_chord_lookup(score) -> list:
    """
    Build sorted list of (abs_quarter_offset, frozenset_of_pitch_classes)
    by chordifying the full score. Returns [] on failure.
    """
    try:
        cf = score.chordify().flatten()
        lookup = []
        for el in cf.getElementsByClass('Chord'):
            pcs = frozenset(p.midi % 12 for p in el.pitches)
            lookup.append((float(el.offset), pcs))
        lookup.sort(key=lambda x: x[0])
        return lookup
    except Exception:
        return []


def chord_pcs_at(lookup: list, abs_offset: float) -> frozenset:
    """Return the pitch-class set of the chord active at abs_offset."""
    pcs: frozenset = frozenset()
    for b, p in lookup:
        if b <= abs_offset + 0.02:
            pcs = p
        else:
            break
    return pcs


def edge_type_cost(pc_i: int, midi_i: int, pc_j: int, midi_j: int,
                   chord_pcs_i: frozenset, chord_pcs_j: frozenset) -> float:
    """
    Tonal cost of edge xi → xj (Wang et al., ISMIR 2025).

    PE  – Prolongational:  same pitch          → 0.10
    LE  – Linear:          chromatic 2nd        → 0.30
    IPE – Imaginary prol.: same pitch class     → 1.00
    ILE – Imaginary lin.:  compound 2nd         → 1.30
    AE  – Arpeggiation:    same chord, >2nd     → 1.50
    UE  – Unclassified                          → 3.00
    """
    if midi_i == midi_j:
        return 0.10
    interval = min((pc_j - pc_i) % 12, (pc_i - pc_j) % 12)
    if interval in (1, 2):
        return 0.30
    if pc_i == pc_j:
        return 1.00
    if interval in (1, 2, 10, 11):
        return 1.30
    if chord_pcs_i and chord_pcs_j and pc_i in chord_pcs_i and pc_j in chord_pcs_j:
        return 1.50
    return 3.00


def note_importance(n: dict, pitch_min: int, pitch_max: int,
                    chord_pcs: frozenset) -> float:
    """Note importance factor α(x) = αp · αo · αd · αh (Wang et al. 2025)."""
    p_mid   = (pitch_min + pitch_max) / 2.0
    p_range = max(pitch_max - pitch_min, 1)
    alpha_p = 0.1 * (0.5 - abs(n['midi'] - p_mid) / p_range) + 1.0

    mw = n['metric_weight']
    if mw >= 4.0:   alpha_o = 0.85
    elif mw >= 2.0: alpha_o = 0.90
    elif mw >= 1.0: alpha_o = 0.95
    else:           alpha_o = 1.10

    dur = n['duration']
    if dur >= 2.0:   alpha_d = 0.85
    elif dur >= 1.0: alpha_d = 0.95
    elif dur >= 0.5: alpha_d = 1.05
    else:            alpha_d = 1.15

    alpha_h = 0.85 if (chord_pcs and n['pc'] in chord_pcs) else 1.15

    return alpha_p * alpha_o * alpha_d * alpha_h


def shortest_path_skeleton(voice: list, chord_lookup: list,
                            beats_per_measure: float = 4.0,
                            max_measure_span: int = 2) -> list:
    """
    Graph-based melody reduction (Wang et al., ISMIR 2025).
    Returns subset of voice notes representing the skeleton.
    """
    import heapq

    if len(voice) <= 2:
        return voice[:]

    N         = len(voice)
    pitch_min = min(n['midi'] for n in voice)
    pitch_max = max(n['midi'] for n in voice)
    eta = 1.6

    abs_beats      = [n['measure_rel'] * beats_per_measure + n['beat'] for n in voice]
    note_chord_pcs = [chord_pcs_at(chord_lookup, ab) for ab in abs_beats]
    importance     = [
        note_importance(voice[i], pitch_min, pitch_max, note_chord_pcs[i])
        for i in range(N)
    ]

    adj: list[list[tuple[float, int]]] = [[] for _ in range(N)]
    for i in range(N):
        for j in range(i + 1, N):
            span = voice[j]['measure_rel'] - voice[i]['measure_rel']
            if span > max_measure_span:
                break
            steps   = j - i
            c_tonal = edge_type_cost(
                voice[i]['pc'], voice[i]['midi'],
                voice[j]['pc'], voice[j]['midi'],
                note_chord_pcs[i], note_chord_pcs[j]
            )
            c_temp = steps ** eta
            cost   = importance[j] * (c_tonal + c_temp)
            adj[i].append((cost, j))

    INF  = float('inf')
    dist = [INF] * N
    prev = [-1] * N
    dist[0] = 0.0
    heap = [(0.0, 0)]

    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u]:
            continue
        for cost, v in adj[u]:
            nd = d + cost
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))

    path = []
    cur  = N - 1
    while cur != -1:
        path.append(cur)
        cur = prev[cur]
    path.reverse()

    if path[0] != 0:
        return voice[:]

    return [voice[i] for i in path]


def extract_skeleton_level(score, start_idx: int, end_idx: int, key_obj,
                            min_metric_weight: float = 0.0,
                            max_measure_span: int = 2) -> list:
    """
    Extract skeleton at a specific structural level.

    Levels:
      min_weight=0.0, span=2 → foreground  (~1-2 notes/measure)
      min_weight=2.0, span=4 → midground   (~1 note/phrase)
      min_weight=4.0, span=8 → background  (~3-5 notes/section)
    """
    parts    = score.parts
    if not parts:
        return []
    top_part = parts[0]
    measures = list(top_part.getElementsByClass('Measure'))
    end_idx  = min(end_idx, len(measures))

    voice = extract_top_voice(measures, start_idx, end_idx)
    if not voice:
        return []

    if min_metric_weight <= 0.0:
        voice = remove_ornaments(voice)
    else:
        voice = [n for n in voice if n['metric_weight'] >= min_metric_weight]

    if len(voice) < 2:
        return voice[:]

    chord_lookup = build_chord_lookup(score)
    ts  = measures[start_idx].getContextByClass('TimeSignature') if measures else None
    bpm = float(ts.numerator) if ts else 4.0

    skeleton = shortest_path_skeleton(voice, chord_lookup,
                                      beats_per_measure=bpm,
                                      max_measure_span=max_measure_span)

    try:
        scale_pcs = set(_pc(p.midi) for p in key_obj.getScale().getPitches('C1', 'C9'))
    except Exception:
        scale_pcs = set(range(12))
    for n in skeleton:
        n['diatonic'] = n['pc'] in scale_pcs
        n['score']    = n['metric_weight'] * n['duration']

    return sorted(skeleton, key=lambda n: (n['measure_rel'], n['beat']))


def match_skeleton_in_section(skeleton: list, score, sec_start: int, sec_end: int) -> dict:
    """
    Find notes in measures[sec_start:sec_end] matching skeleton pitch classes
    at structurally equivalent metric positions.
    Returns dict[abs_measure_idx (int)] → list of {beat, pc, midi}.
    """
    parts    = score.parts
    if not parts:
        return {}
    top_part = parts[0]
    measures = list(top_part.getElementsByClass('Measure'))
    sec_end  = min(sec_end, len(measures))

    period = (max(n['measure_rel'] for n in skeleton) + 1) if skeleton else 1
    sk_lookup: dict = {}
    for n in skeleton:
        key = (n['measure_rel'] % period, round(n['beat'] * 2) / 2.0)
        sk_lookup.setdefault(key, set()).add(n['pc'])

    highlights: dict = {}
    for rel in range(sec_end - sec_start):
        abs_idx     = sec_start + rel
        m           = measures[abs_idx]
        measure_mod = rel % period

        beat_notes: dict = {}
        for el in m.recurse().notesAndRests:
            beat = float(el.offset)
            dur  = float(el.duration.quarterLength)
            if hasattr(el, 'pitch'):
                beat_notes.setdefault(beat, []).append((el.pitch.midi, dur))
            elif hasattr(el, 'pitches'):
                for p in el.pitches:
                    beat_notes.setdefault(beat, []).append((p.midi, dur))

        for beat in sorted(beat_notes.keys()):
            beat_key   = (measure_mod, round(beat * 2) / 2.0)
            target_pcs = sk_lookup.get(beat_key)
            if not target_pcs:
                continue
            top_midi, _ = max(beat_notes[beat], key=lambda x: x[0])
            top_pc = _pc(top_midi)
            if top_pc in target_pcs:
                highlights.setdefault(abs_idx, []).append({
                    'beat': beat,
                    'pc':   top_pc,
                    'midi': top_midi,
                })
    return highlights
