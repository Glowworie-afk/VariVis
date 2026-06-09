"""
API tests:
  GET /api/score/pdf/{file_name}
  GET /api/score/match
  GET /api/score/musicxml/{file_name}
  GET /api/score/mxl_notes/{file_name}
"""


class TestScorePdf:
    def test_404_when_no_matching_pdf(self, client):
        r = client.get("/api/score/pdf/nonexistent_piece_xyz")
        assert r.status_code == 404

    def test_404_body_contains_matched_false(self, client):
        r = client.get("/api/score/pdf/nonexistent_piece_xyz")
        detail = r.json().get("detail", {})
        assert detail.get("matched") is False

    def test_404_body_lists_available_pdfs(self, client):
        r = client.get("/api/score/pdf/nonexistent_piece_xyz")
        detail = r.json().get("detail", {})
        assert "available" in detail


class TestScoreMatch:
    def test_always_200(self, client):
        r = client.get("/api/score/match")
        assert r.status_code == 200

    def test_returns_matched_key(self, client):
        r = client.get("/api/score/match")
        assert "matched" in r.json()

    def test_returns_available_list(self, client):
        r = client.get("/api/score/match")
        assert isinstance(r.json()["available"], list)

    def test_with_file_name_param(self, client):
        r = client.get("/api/score/match?file_name=WAMozart_K265_1&music_name=K265")
        assert r.status_code == 200
        assert "score" in r.json()


class TestScoreMusicxml:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/score/musicxml/nonexistent_piece_xyz")
        assert r.status_code == 404


class TestScoreMxlNotes:
    def test_available_false_for_nonexistent(self, client):
        r = client.get("/api/score/mxl_notes/nonexistent_piece_xyz")
        assert r.status_code == 200
        assert r.json()["available"] is False
