import pytest
from app.services.score_matching import extract_catalog_numbers


class TestExtractCatalogNumbers:
    # ── Mozart / K number ────────────────────────────────────────────
    def test_filename_mozart_k(self):
        result = extract_catalog_numbers("WAMozart_K265_1")
        assert result["kv"] == "265"
        assert result["composer"] == "mozart"

    def test_natural_language_mozart_k_dot(self):
        result = extract_catalog_numbers("Wolfgang Amadeus Mozart: K.265")
        assert result["kv"] == "265"

    # ── Beethoven / Op number ─────────────────────────────────────────
    def test_filename_beethoven_op(self):
        result = extract_catalog_numbers("LBeethoven_OP34_1")
        assert result["op"] == "34"
        assert result["composer"] == "beethoven"

    def test_natural_language_opus(self):
        result = extract_catalog_numbers("Beethoven - 6 Variations, Op. 34")
        assert result["op"] == "34"

    # ── Beethoven / WoO number ────────────────────────────────────────
    def test_filename_beethoven_woo(self):
        result = extract_catalog_numbers("LBeethoven_WOO67_2")
        assert result["woo"] == "67"

    # ── Haydn / Hob number ───────────────────────────────────────────
    def test_filename_haydn_hob(self):
        result = extract_catalog_numbers("JHaydn_XVII5_1")
        assert result["hob"] == "17_5"

    # ── Composer detection ───────────────────────────────────────────
    def test_unknown_composer_absent(self):
        result = extract_catalog_numbers("Op. 34")
        assert "composer" not in result

    def test_case_insensitive_composer(self):
        result = extract_catalog_numbers("beethoven op 76")
        assert result.get("composer") == "beethoven"

    # ── Empty / no match ─────────────────────────────────────────────
    def test_empty_string(self):
        assert extract_catalog_numbers("") == {}

    def test_no_numbers_found(self):
        result = extract_catalog_numbers("some random text")
        assert "kv" not in result
        assert "op" not in result
