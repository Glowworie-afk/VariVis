import pytest
from app.services.upload import mmss_to_sec, parse_boundaries, auto_labels


class TestMmssTosec:
    def test_zero(self):
        assert mmss_to_sec(0.0) == 0.0

    def test_whole_minutes(self):
        assert mmss_to_sec(2.0) == 120.0

    def test_minutes_and_seconds(self):
        assert mmss_to_sec(1.41) == pytest.approx(101.0)

    def test_sub_minute(self):
        assert mmss_to_sec(0.30) == pytest.approx(30.0)

    def test_large_value(self):
        assert mmss_to_sec(10.00) == pytest.approx(600.0)


class TestParseBoundaries:
    def test_basic(self):
        assert parse_boundaries("0.00, 1.30, 3.00") == pytest.approx([0.0, 90.0, 180.0])

    def test_single_value(self):
        assert parse_boundaries("2.00") == pytest.approx([120.0])

    def test_output_is_sorted(self):
        result = parse_boundaries("3.00, 1.00, 2.00")
        assert result == sorted(result)

    def test_ignores_blank_parts(self):
        assert parse_boundaries("0.00,, 1.00") == pytest.approx([0.0, 60.0])

    def test_ignores_non_numeric(self):
        assert parse_boundaries("0.00, abc, 1.00") == pytest.approx([0.0, 60.0])

    def test_empty_string(self):
        assert parse_boundaries("") == []


class TestAutoLabels:
    def test_theme_only(self):
        assert auto_labels(1) == ["T"]

    def test_theme_and_one_variation(self):
        assert auto_labels(2) == ["T", "V1"]

    def test_multiple_variations(self):
        assert auto_labels(4) == ["T", "V1", "V2", "V3"]

    def test_length_matches_input(self):
        n = 6
        assert len(auto_labels(n)) == n
