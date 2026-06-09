import numpy as np
import pytest
from app.services.audio import (
    safe_float,
    safe_list,
    chroma_to_cof,
    dominant_pitch,
    compress_to_n_frames,
    compress_chroma_to_n_frames,
    COF_ORDER,
    CHROMA_NAMES,
)


class TestSafeFloat:
    def test_normal_value(self):
        assert safe_float(3.14) == pytest.approx(3.14)

    def test_nan_returns_zero(self):
        assert safe_float(float("nan")) == 0.0

    def test_inf_returns_zero(self):
        assert safe_float(float("inf")) == 0.0

    def test_negative_inf_returns_zero(self):
        assert safe_float(float("-inf")) == 0.0

    def test_zero(self):
        assert safe_float(0.0) == 0.0


class TestSafeList:
    def test_normal_values(self):
        assert safe_list([1.0, 2.0, 3.0]) == pytest.approx([1.0, 2.0, 3.0])

    def test_replaces_nan(self):
        result = safe_list([1.0, float("nan"), 3.0])
        assert result[1] == 0.0

    def test_replaces_inf(self):
        result = safe_list([float("inf"), 2.0])
        assert result[0] == 0.0

    def test_empty(self):
        assert safe_list([]) == []


class TestChromaToCof:
    def test_length_preserved(self):
        chroma = list(range(12))
        result = chroma_to_cof(chroma)
        assert len(result) == 12

    def test_reorders_by_cof(self):
        # identity chroma [0..11] → result[i] should equal COF_ORDER[i]
        chroma = list(range(12))
        result = chroma_to_cof(chroma)
        assert result == COF_ORDER

    def test_uniform_chroma_unchanged(self):
        chroma = [1.0] * 12
        assert chroma_to_cof(chroma) == [1.0] * 12


class TestDominantPitch:
    def test_returns_name_and_cof_index(self):
        chroma = [0.0] * 12
        chroma[0] = 1.0  # C is strongest
        result = dominant_pitch(chroma)
        assert result["name"] == "C"
        assert isinstance(result["cof_index"], int)

    def test_all_pitch_classes_reachable(self):
        for pc in range(12):
            chroma = [0.0] * 12
            chroma[pc] = 1.0
            result = dominant_pitch(chroma)
            assert result["name"] == CHROMA_NAMES[pc]

    def test_cof_index_in_range(self):
        chroma = [0.0] * 12
        chroma[7] = 1.0  # G
        result = dominant_pitch(chroma)
        assert 0 <= result["cof_index"] < 12


class TestCompressToNFrames:
    def test_output_length(self):
        signal = np.ones(128)
        assert len(compress_to_n_frames(signal, n=64)) == 64

    def test_custom_n(self):
        signal = np.ones(100)
        assert len(compress_to_n_frames(signal, n=16)) == 16

    def test_constant_signal_preserved(self):
        signal = np.full(64, 3.0)
        result = compress_to_n_frames(signal, n=8)
        assert result == pytest.approx([3.0] * 8)

    def test_empty_signal(self):
        result = compress_to_n_frames(np.array([]), n=64)
        assert result == [0.0] * 64

    def test_shorter_than_n(self):
        signal = np.ones(4)
        result = compress_to_n_frames(signal, n=16)
        assert len(result) == 16


class TestCompressChromaToNFrames:
    def test_output_is_12_rows(self):
        matrix = np.random.rand(12, 200)
        result = compress_chroma_to_n_frames(matrix, n=64)
        assert len(result) == 12

    def test_each_row_has_n_frames(self):
        matrix = np.random.rand(12, 200)
        result = compress_chroma_to_n_frames(matrix, n=32)
        assert all(len(row) == 32 for row in result)

    def test_rows_follow_cof_order(self):
        # row i should contain the compressed signal for COF_ORDER[i]
        matrix = np.zeros((12, 10))
        for pc in range(12):
            matrix[pc, :] = float(pc)  # row pc has constant value = pc
        result = compress_chroma_to_n_frames(matrix, n=4)
        for i, pc in enumerate(COF_ORDER):
            assert result[i] == pytest.approx([float(pc)] * 4)

    def test_uniform_matrix(self):
        matrix = np.ones((12, 64))
        result = compress_chroma_to_n_frames(matrix, n=8)
        assert all(v == pytest.approx(1.0) for row in result for v in row)
