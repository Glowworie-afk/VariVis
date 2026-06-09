from app.services.midi import extract_k_number


class TestExtractKNumber:
    def test_filename_format(self):
        assert extract_k_number("WAMozart_K265_1") == "265"

    def test_lowercase_k(self):
        assert extract_k_number("mozart_k331") == "331"

    def test_k_with_dot(self):
        assert extract_k_number("K.265") == "265"

    def test_kv_prefix(self):
        assert extract_k_number("KV550") == "550"

    def test_no_k_number_returns_none(self):
        assert extract_k_number("LBeethoven_OP34_1") is None

    def test_empty_string_returns_none(self):
        assert extract_k_number("") is None

    def test_three_digit_number(self):
        assert extract_k_number("K626") == "626"
