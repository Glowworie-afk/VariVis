import pytest
from app.services.musicvis import (
    degree_to_function,
    metric_weight,
    _pc,
    step_interval,
    remove_ornaments,
    chord_pcs_at,
    edge_type_cost,
    note_importance,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _note(pc: int, midi: int, duration: float, mw: float, beat: float = 0.0) -> dict:
    return {"measure_rel": 0, "beat": beat, "pc": pc, "midi": midi,
            "duration": duration, "metric_weight": mw}


# ── degree_to_function ────────────────────────────────────────────────────────

class TestDegreeToFunction:
    def test_tonic_degrees(self):
        assert degree_to_function(1) == "T"
        assert degree_to_function(3) == "T"
        assert degree_to_function(6) == "T"

    def test_subdominant_degrees(self):
        assert degree_to_function(2) == "S"
        assert degree_to_function(4) == "S"

    def test_dominant_degrees(self):
        assert degree_to_function(5) == "D"
        assert degree_to_function(7) == "D"

    def test_out_of_range_returns_other(self):
        assert degree_to_function(0)  == "O"
        assert degree_to_function(8)  == "O"
        assert degree_to_function(99) == "O"


# ── metric_weight ─────────────────────────────────────────────────────────────

class TestMetricWeight:
    def test_downbeat_is_four(self):
        assert metric_weight(0.0, 4) == 4.0

    def test_midbar_in_4_4_is_two(self):
        assert metric_weight(2.0, 4) == 2.0

    def test_beat_on_integer_offset_is_one(self):
        assert metric_weight(1.0, 4) == 1.0
        assert metric_weight(3.0, 4) == 1.0

    def test_offbeat_is_half(self):
        assert metric_weight(0.5, 4) == 0.5
        assert metric_weight(1.25, 4) == 0.5

    def test_3_4_beat_on_integer_is_one(self):
        # ts_num=3 < 4, so midbar check is skipped; beat 1.0 is integer offset → 1.0
        assert metric_weight(1.0, 3) == 1.0

    def test_downbeat_all_ts(self):
        for ts in (2, 3, 4, 6):
            assert metric_weight(0.0, ts) == 4.0


# ── _pc ───────────────────────────────────────────────────────────────────────

class TestPc:
    def test_c4_is_0(self):
        assert _pc(60) == 0

    def test_wraps_at_12(self):
        assert _pc(61) == 1
        assert _pc(72) == 0

    def test_all_pcs_in_range(self):
        for midi in range(21, 109):
            assert 0 <= _pc(midi) < 12


# ── step_interval ─────────────────────────────────────────────────────────────

class TestStepInterval:
    def test_semitone_is_step(self):
        assert step_interval(0, 1) is True

    def test_whole_tone_is_step(self):
        assert step_interval(0, 2) is True

    def test_minor_third_is_not_step(self):
        assert step_interval(0, 3) is False

    def test_wraps_around_octave(self):
        # B→C is a semitone (11→0)
        assert step_interval(11, 0) is True

    def test_tritone_is_not_step(self):
        assert step_interval(0, 6) is False

    def test_symmetry(self):
        assert step_interval(2, 0) == step_interval(0, 2)


# ── remove_ornaments ──────────────────────────────────────────────────────────

class TestRemoveOrnaments:
    def test_fewer_than_3_notes_unchanged(self):
        notes = [_note(0, 60, 0.5, 1.0), _note(2, 62, 0.5, 1.0)]
        assert remove_ornaments(notes) == notes

    def test_strong_beat_note_kept(self):
        # middle note: strong beat → never removed
        notes = [
            _note(0, 60, 1.0, 1.0),
            _note(2, 62, 0.1, 1.0),   # mw=1.0, not weak
            _note(4, 64, 1.0, 1.0),
        ]
        assert len(remove_ornaments(notes)) == 3

    def test_long_note_kept(self):
        # middle note: weak beat but duration >= 0.25 → kept
        notes = [
            _note(0, 60, 1.0, 1.0),
            _note(2, 62, 0.5, 0.5),   # mw=0.5, dur=0.5 (not short)
            _note(4, 64, 1.0, 1.0),
        ]
        assert len(remove_ornaments(notes)) == 3

    def test_passing_note_removed(self):
        # C(0) → D(2) → E(4): stepwise ascending, weak beat, short → removed
        notes = [
            _note(0, 60, 1.0, 1.0),
            _note(2, 62, 0.1, 0.5),   # passing note
            _note(4, 64, 1.0, 1.0),
        ]
        result = remove_ornaments(notes)
        assert len(result) == 2
        assert result[0]["pc"] == 0
        assert result[1]["pc"] == 4

    def test_neighbor_note_removed(self):
        # C(0) → D(2) → C(0): neighbor motion, weak beat, short → removed
        notes = [
            _note(0, 60, 1.0, 1.0),
            _note(2, 62, 0.1, 0.5),   # neighbor
            _note(0, 60, 1.0, 1.0),
        ]
        result = remove_ornaments(notes)
        assert len(result) == 2


# ── chord_pcs_at ──────────────────────────────────────────────────────────────

class TestChordPcsAt:
    def _lookup(self):
        return [
            (0.0,  frozenset({0, 4, 7})),   # C major at beat 0
            (2.0,  frozenset({5, 9, 0})),   # F major at beat 2
            (4.0,  frozenset({7, 11, 2})),  # G major at beat 4
        ]

    def test_exact_offset_match(self):
        assert chord_pcs_at(self._lookup(), 0.0) == frozenset({0, 4, 7})

    def test_offset_between_chords(self):
        # 3.0 is between 2.0 and 4.0 → F major still active
        assert chord_pcs_at(self._lookup(), 3.0) == frozenset({5, 9, 0})

    def test_last_chord_active_beyond_end(self):
        assert chord_pcs_at(self._lookup(), 10.0) == frozenset({7, 11, 2})

    def test_empty_lookup_returns_empty(self):
        assert chord_pcs_at([], 1.0) == frozenset()

    def test_just_before_second_chord(self):
        # 1.98 < 2.0 - 0.02 threshold → still first chord
        assert chord_pcs_at(self._lookup(), 1.97) == frozenset({0, 4, 7})


# ── edge_type_cost ────────────────────────────────────────────────────────────

class TestEdgeTypeCost:
    def test_same_midi_is_pe(self):
        assert edge_type_cost(0, 60, 0, 60, frozenset(), frozenset()) == pytest.approx(0.10)

    def test_semitone_is_le(self):
        assert edge_type_cost(0, 60, 1, 61, frozenset(), frozenset()) == pytest.approx(0.30)

    def test_whole_tone_is_le(self):
        assert edge_type_cost(0, 60, 2, 62, frozenset(), frozenset()) == pytest.approx(0.30)

    def test_same_pc_different_midi_is_ipe(self):
        # C4 (60) → C5 (72): same pc=0, different midi
        assert edge_type_cost(0, 60, 0, 72, frozenset(), frozenset()) == pytest.approx(1.00)

    def test_chord_tone_to_chord_tone_is_ae(self):
        # C(0)→E(4) in C-major chord, interval=4 (not step, not same pc)
        cpc = frozenset({0, 4, 7})
        assert edge_type_cost(0, 60, 4, 64, cpc, cpc) == pytest.approx(1.50)

    def test_unrelated_leap_is_ue(self):
        # C(0) → F#(6): tritone, no chord context
        assert edge_type_cost(0, 60, 6, 66, frozenset(), frozenset()) == pytest.approx(3.00)


# ── note_importance ───────────────────────────────────────────────────────────

class TestNoteImportance:
    def _basic_note(self, midi: int = 64, mw: float = 1.0, dur: float = 1.0) -> dict:
        return {"midi": midi, "pc": midi % 12, "metric_weight": mw, "duration": dur}

    def test_returns_positive_float(self):
        n = self._basic_note()
        result = note_importance(n, pitch_min=60, pitch_max=72, chord_pcs=frozenset())
        assert isinstance(result, float)
        assert result > 0

    def test_strong_beat_lower_than_weak_beat(self):
        # alpha_o: mw=4.0 → 0.85; mw=0.5 → 1.10 → strong beat has lower cost
        strong = note_importance(self._basic_note(mw=4.0), 60, 72, frozenset())
        weak   = note_importance(self._basic_note(mw=0.5), 60, 72, frozenset())
        assert strong < weak

    def test_chord_tone_lower_than_non_chord(self):
        # alpha_h: chord tone → 0.85; non-chord → 1.15
        n = self._basic_note(midi=60)   # pc=0 (C)
        in_chord  = note_importance(n, 60, 72, frozenset({0, 4, 7}))
        out_chord = note_importance(n, 60, 72, frozenset({2, 5, 9}))
        assert in_chord < out_chord

    def test_long_note_lower_than_short(self):
        # alpha_d: dur>=2.0 → 0.85; dur<0.5 → 1.15
        long_n  = note_importance(self._basic_note(dur=2.0), 60, 72, frozenset())
        short_n = note_importance(self._basic_note(dur=0.2), 60, 72, frozenset())
        assert long_n < short_n
