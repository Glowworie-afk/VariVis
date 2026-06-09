import pytest
from app.services.symbolic import mxl_label_key, mxl_key_to_label, compute_distributions


# ── mxl_label_key ─────────────────────────────────────────────────────────────

class TestMxlLabelKey:
    def test_theme_labels(self):
        for lbl in ("T", "t", "Theme", "Thema", "tema"):
            assert mxl_label_key(lbl) == 0

    def test_coda_labels(self):
        for lbl in ("C", "c", "Coda", "FINALE"):
            assert mxl_label_key(lbl) == 999

    def test_variation_with_digit(self):
        assert mxl_label_key("Var. 1")  == 1
        assert mxl_label_key("Var 12")  == 12

    def test_variation_with_roman(self):
        assert mxl_label_key("Var. I")    == 1
        assert mxl_label_key("Var. VIII") == 8

    def test_unknown_label(self):
        assert mxl_label_key("Bridge") == 998

    def test_whitespace_stripped(self):
        assert mxl_label_key("  Theme  ") == 0


# ── mxl_key_to_label ──────────────────────────────────────────────────────────

class TestMxlKeyToLabel:
    def test_zero_is_theme(self):
        assert mxl_key_to_label(0) == "T"

    def test_999_is_coda(self):
        assert mxl_key_to_label(999) == "C"

    def test_variation_number(self):
        assert mxl_key_to_label(1)  == "V1"
        assert mxl_key_to_label(12) == "V12"

    def test_998_falls_back_to_orig(self):
        assert mxl_key_to_label(998, orig="Bridge") == "Bridge"

    def test_998_with_no_orig_returns_question_mark(self):
        assert mxl_key_to_label(998) == "?"

    def test_roundtrip(self):
        for key in (0, 1, 5, 12, 999):
            label = mxl_key_to_label(key)
            assert mxl_label_key(label) == key


# ── compute_distributions ─────────────────────────────────────────────────────

def _note(pitch: int, start: float, dur: float) -> dict:
    return {"pitch": pitch, "start_sec": start, "dur_sec": dur}


class TestComputeDistributions:
    def test_returns_three_keys(self):
        result = compute_distributions([_note(60, 0.0, 0.5)])
        assert set(result) == {"pitch_class", "melodic_interval", "note_duration"}

    def test_pitch_class_has_12_bins(self):
        result = compute_distributions([_note(60, 0.0, 0.5)])
        assert len(result["pitch_class"]) == 12

    def test_melodic_interval_has_13_bins(self):
        result = compute_distributions([_note(60, 0.0, 0.5)])
        assert len(result["melodic_interval"]) == 13

    def test_note_duration_has_12_bins(self):
        result = compute_distributions([_note(60, 0.0, 0.5)])
        assert len(result["note_duration"]) == 12

    def test_pitch_class_normalized(self):
        notes = [_note(60, 0.0, 0.5), _note(64, 1.0, 0.5), _note(67, 2.0, 0.5)]
        result = compute_distributions(notes)
        assert sum(result["pitch_class"]) == pytest.approx(1.0, abs=1e-4)

    def test_note_duration_normalized(self):
        notes = [_note(60, i * 0.5, 0.2) for i in range(5)]
        result = compute_distributions(notes)
        assert sum(result["note_duration"]) == pytest.approx(1.0)

    def test_melodic_interval_normalized_with_multiple_notes(self):
        notes = [_note(60, 0.0, 0.5), _note(62, 1.0, 0.5), _note(64, 2.0, 0.5)]
        result = compute_distributions(notes)
        assert sum(result["melodic_interval"]) == pytest.approx(1.0)

    def test_single_note_melodic_interval_all_zero(self):
        result = compute_distributions([_note(60, 0.0, 0.5)])
        assert sum(result["melodic_interval"]) == pytest.approx(0.0)

    def test_empty_notes_returns_zero_distributions(self):
        # total_pc = sum([0]*12) or 1.0 → 0.0/1.0 = 0.0 for each bin
        result = compute_distributions([])
        assert sum(result["pitch_class"])      == pytest.approx(0.0)
        assert sum(result["melodic_interval"]) == pytest.approx(0.0)
        assert sum(result["note_duration"])    == pytest.approx(0.0)

    def test_pitch_class_correct_bin(self):
        # C (midi=60, pc=0) only → bin 0 should be 1.0
        result = compute_distributions([_note(60, 0.0, 0.5)])
        assert result["pitch_class"][0] == pytest.approx(1.0)
        assert all(v == pytest.approx(0.0) for v in result["pitch_class"][1:])

    def test_large_interval_goes_to_last_bin(self):
        # C4 (60) → C6 (84): interval = 24 → clamped to bin 12 (≥12)
        notes = [_note(60, 0.0, 0.5), _note(84, 1.0, 0.5)]
        result = compute_distributions(notes)
        assert result["melodic_interval"][12] == pytest.approx(1.0)
