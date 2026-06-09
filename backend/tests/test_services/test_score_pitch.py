import numpy as np
import pytest
from app.services.score_pitch import label_key, _detect_key, _to_relative


class TestLabelKey:
    def test_theme_labels(self):
        for lbl in ("T", "t", "Theme", "THEMA", "tema"):
            assert label_key(lbl) == 0

    def test_coda_labels(self):
        for lbl in ("C", "c", "Coda", "FINALE"):
            assert label_key(lbl) == 999

    def test_variation_with_digit(self):
        assert label_key("V1")   == 1
        assert label_key("Var3") == 3
        assert label_key("12")   == 12

    def test_variation_with_roman(self):
        assert label_key("Var. I")   == 1
        assert label_key("Var. IV")  == 4
        assert label_key("Var. XII") == 12

    def test_unknown_label(self):
        assert label_key("Interlude") == 998

    def test_whitespace_stripped(self):
        assert label_key("  T  ") == 0


class TestDetectKey:
    def test_returns_required_fields(self):
        result = _detect_key(np.ones(12))
        assert {"score_tonic_semitone", "score_tonic_name",
                "score_is_major", "score_key_correlation"} == set(result)

    def test_c_major_profile_detected_as_c(self):
        from app.services.score_pitch import TEMPERLEY_MAJOR
        result = _detect_key(TEMPERLEY_MAJOR)
        assert result["score_tonic_semitone"] == 0
        assert result["score_is_major"] is True

    def test_tonic_semitone_in_range(self):
        result = _detect_key(np.random.dirichlet(np.ones(12)))
        assert 0 <= result["score_tonic_semitone"] < 12

    def test_zero_chroma_does_not_crash(self):
        # sum < 1e-9 → falls back to uniform, should not raise
        result = _detect_key(np.zeros(12))
        assert "score_tonic_semitone" in result

    def test_correlation_finite(self):
        result = _detect_key(np.array([1.0] + [0.0] * 11))
        assert np.isfinite(result["score_key_correlation"])


class TestToRelative:
    def test_empty_returns_empty(self):
        assert _to_relative([], tonic=0) == []

    def test_length_preserved(self):
        vals = [60, 62, 64, 65, 67]
        assert len(_to_relative(vals, tonic=0)) == len(vals)

    def test_transposition_invariant(self):
        vals  = [60, 62, 64]
        shift = 5
        r1 = _to_relative(vals, tonic=0)
        r2 = _to_relative([v + shift for v in vals], tonic=shift)
        assert r1 == pytest.approx(r2)

    def test_tonic_reference_near_zero(self):
        # C4=60 with tonic C(0) → relative to nearest C octave
        result = _to_relative([60, 64, 67], tonic=0)
        assert abs(result[0]) <= 12
