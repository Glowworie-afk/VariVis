import numpy as np
import pytest
from app.services.pitch_contour import detect_key, midi_to_relative


class TestDetectKey:
    def test_returns_required_fields(self):
        chroma = [1.0] + [0.0] * 11
        result = detect_key(chroma)
        assert {"tonic_semitone", "tonic_name", "is_major", "key_correlation"} == set(result)

    def test_c_major_profile_detected_as_c(self):
        # Feed the C-major Temperley profile directly — should detect C major
        from app.services.pitch_contour import TEMPERLEY_MAJOR
        result = detect_key(list(TEMPERLEY_MAJOR))
        assert result["tonic_semitone"] == 0
        assert result["is_major"] is True

    def test_tonic_semitone_in_range(self):
        chroma = np.random.dirichlet(np.ones(12)).tolist()
        result = detect_key(chroma)
        assert 0 <= result["tonic_semitone"] < 12

    def test_correlation_between_neg1_and_1(self):
        chroma = [1.0] + [0.0] * 11
        result = detect_key(chroma)
        assert -1.0 <= result["key_correlation"] <= 1.0

    def test_uniform_chroma_does_not_crash(self):
        chroma = [1.0 / 12] * 12
        result = detect_key(chroma)
        assert "tonic_semitone" in result


class TestMidiToRelative:
    def test_empty_returns_empty(self):
        assert midi_to_relative([], tonic_semitone=0) == []

    def test_values_centered_near_zero(self):
        # MIDI 60 (C4) with tonic=0 (C) → relative offset should be near 0
        result = midi_to_relative([60, 62, 64], tonic_semitone=0)
        assert abs(result[0]) <= 12

    def test_length_preserved(self):
        vals = [60, 61, 62, 63, 64]
        result = midi_to_relative(vals, tonic_semitone=0)
        assert len(result) == len(vals)

    def test_transposition_invariant(self):
        # Shifting all notes + tonic by same interval → same relative values
        vals = [60, 62, 64]
        shift = 5
        r1 = midi_to_relative(vals, tonic_semitone=0)
        r2 = midi_to_relative([v + shift for v in vals], tonic_semitone=shift)
        assert r1 == pytest.approx(r2)
