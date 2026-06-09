"""
API tests: GET /api/symbolic/{file_name}

Behaviour by input:
  - temp_ prefix, no MXL → 200 matched=false
  - no MXL, no feature file → 404
  - MXL found → 200 matched=true (tested via monkeypatch)
"""

import json


class TestSymbolicFeatures:
    def test_404_when_no_feature_file(self, client):
        r = client.get("/api/symbolic/nonexistent_piece_xyz")
        assert r.status_code == 404

    def test_temp_piece_no_mxl_returns_200_unmatched(self, client):
        # temp_ prefix → graceful unmatched response, not 404
        r = client.get("/api/symbolic/temp_no_mxl_piece")
        assert r.status_code == 200
        data = r.json()
        assert data["matched"] is False

    def test_temp_piece_response_has_feature_defs(self, client):
        r = client.get("/api/symbolic/temp_no_mxl_piece")
        assert "feature_defs" in r.json()

    def test_temp_piece_response_has_empty_segments(self, client):
        r = client.get("/api/symbolic/temp_no_mxl_piece")
        assert r.json()["segments"] == []

    def test_mxl_happy_path(self, client, monkeypatch, tmp_path, sample_feature):
        """When parse_mxl_symbolic returns data, route returns matched=true."""
        from app.services.symbolic import SYMBOLIC_FEATURE_DEFS

        mock_sections = [
            {
                "label":       "T",
                "notes_sec":   [
                    {"pitch": 60, "start_sec": 0.0, "dur_sec": 0.5},
                    {"pitch": 62, "start_sec": 0.5, "dur_sec": 0.5},
                ],
                "seg_dur_sec": 1.0,
            },
            {
                "label":       "V1",
                "notes_sec":   [
                    {"pitch": 64, "start_sec": 0.0, "dur_sec": 0.5},
                ],
                "seg_dur_sec": 1.0,
            },
        ]
        monkeypatch.setattr("app.api.symbolic.parse_mxl_symbolic",
                            lambda stem: mock_sections)
        r = client.get("/api/symbolic/WAMozart_K265_1")
        assert r.status_code == 200
        data = r.json()
        assert data["matched"] is True
        assert data["source"] == "musicxml"

    def test_mxl_happy_path_has_segments(self, client, monkeypatch):
        mock_sections = [
            {"label": "T",  "notes_sec": [{"pitch": 60, "start_sec": 0.0, "dur_sec": 0.5}],
             "seg_dur_sec": 1.0},
            {"label": "V1", "notes_sec": [{"pitch": 62, "start_sec": 0.0, "dur_sec": 0.5}],
             "seg_dur_sec": 1.0},
        ]
        monkeypatch.setattr("app.api.symbolic.parse_mxl_symbolic",
                            lambda stem: mock_sections)
        r = client.get("/api/symbolic/WAMozart_K265_1")
        segs = r.json()["segments"]
        assert len(segs) >= 1
        assert "features" in segs[0]
        assert "distributions" in segs[0]

    def test_coda_segments_excluded(self, client, monkeypatch):
        # Segments with label "C" should be filtered out
        mock_sections = [
            {"label": "T",  "notes_sec": [{"pitch": 60, "start_sec": 0.0, "dur_sec": 0.5}],
             "seg_dur_sec": 1.0},
            {"label": "C",  "notes_sec": [{"pitch": 67, "start_sec": 0.0, "dur_sec": 0.5}],
             "seg_dur_sec": 1.0},
        ]
        monkeypatch.setattr("app.api.symbolic.parse_mxl_symbolic",
                            lambda stem: mock_sections)
        r = client.get("/api/symbolic/WAMozart_K265_1")
        labels = [s["label"] for s in r.json()["segments"]]
        assert "C" not in labels
