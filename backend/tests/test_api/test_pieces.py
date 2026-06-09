"""
API tests: GET /api/pieces  /api/features/{file_name}  /api/audio/{file_name}
"""

import json
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest


# ── GET /api/pieces ───────────────────────────────────────────────────────────

class TestListPieces:
    def test_500_when_annotation_missing(self, client, monkeypatch):
        mock_ann = MagicMock()
        mock_ann.exists.return_value = False
        monkeypatch.setattr("app.api.pieces.ANNOTATION", mock_ann)
        r = client.get("/api/pieces")
        assert r.status_code == 500

    def test_200_returns_list(self, client, monkeypatch, tmp_path):
        df = pd.DataFrame([{
            "folder":                          "Mozart",
            "file_name (folderName_number)":   "WAMozart_K265_1",
            "music_name":                      "K265 Var 1",
            "composer":                        "Mozart",
            "instrument":                      "Piano",
            "period":                          "Classical",
        }])
        mock_ann = MagicMock()
        mock_ann.exists.return_value = True
        monkeypatch.setattr("app.api.pieces.ANNOTATION", mock_ann)
        monkeypatch.setattr("app.api.pieces.FEATURE_DIR", tmp_path)
        with patch("app.api.pieces.pd.read_excel", return_value=df):
            r = client.get("/api/pieces")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) == 1

    def test_piece_has_required_keys(self, client, monkeypatch, tmp_path):
        df = pd.DataFrame([{
            "folder":                         "Mozart",
            "file_name (folderName_number)":  "WAMozart_K265_1",
            "music_name": "K265", "composer": "Mozart",
            "instrument": "Piano", "period":  "Classical",
        }])
        mock_ann = MagicMock()
        mock_ann.exists.return_value = True
        monkeypatch.setattr("app.api.pieces.ANNOTATION", mock_ann)
        monkeypatch.setattr("app.api.pieces.FEATURE_DIR", tmp_path)
        with patch("app.api.pieces.pd.read_excel", return_value=df):
            r = client.get("/api/pieces")
        piece = r.json()[0]
        for key in ("file_name", "music_name", "composer", "extracted", "has_midi"):
            assert key in piece, f"missing key: {key}"

    def test_extracted_true_when_json_exists(self, client, monkeypatch,
                                              tmp_path, sample_feature):
        name = "WAMozart_K265_1"
        (tmp_path / f"{name}.json").write_text(json.dumps(sample_feature))
        df = pd.DataFrame([{
            "folder":                        "Mozart",
            "file_name (folderName_number)": name,
            "music_name": "K265", "composer": "Mozart",
            "instrument": "Piano", "period":  "Classical",
        }])
        mock_ann = MagicMock()
        mock_ann.exists.return_value = True
        monkeypatch.setattr("app.api.pieces.ANNOTATION", mock_ann)
        monkeypatch.setattr("app.api.pieces.FEATURE_DIR", tmp_path)
        with patch("app.api.pieces.pd.read_excel", return_value=df):
            r = client.get("/api/pieces")
        assert r.json()[0]["extracted"] is True

    def test_skips_empty_file_name_rows(self, client, monkeypatch, tmp_path):
        df = pd.DataFrame([
            {"folder": "Mozart", "file_name (folderName_number)": "",
             "music_name": "", "composer": "", "instrument": "", "period": ""},
            {"folder": "Mozart", "file_name (folderName_number)": "WAMozart_K265_1",
             "music_name": "K265", "composer": "Mozart",
             "instrument": "Piano", "period": "Classical"},
        ])
        mock_ann = MagicMock()
        mock_ann.exists.return_value = True
        monkeypatch.setattr("app.api.pieces.ANNOTATION", mock_ann)
        monkeypatch.setattr("app.api.pieces.FEATURE_DIR", tmp_path)
        with patch("app.api.pieces.pd.read_excel", return_value=df):
            r = client.get("/api/pieces")
        assert len(r.json()) == 1


# ── GET /api/features/{file_name} ─────────────────────────────────────────────

class TestGetFeatures:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/features/nonexistent_piece_xyz")
        assert r.status_code == 404

    def test_200_returns_feature_json(self, client, feature_dir, sample_feature):
        r = client.get("/api/features/WAMozart_K265_1")
        assert r.status_code == 200
        data = r.json()
        assert "metadata" in data
        assert "segments" in data

    def test_metadata_file_name_matches(self, client, feature_dir):
        r = client.get("/api/features/WAMozart_K265_1")
        assert r.json()["metadata"]["file_name"] == "WAMozart_K265_1"

    def test_segments_is_list(self, client, feature_dir):
        r = client.get("/api/features/WAMozart_K265_1")
        assert isinstance(r.json()["segments"], list)


# ── GET /api/audio/{file_name} ────────────────────────────────────────────────

class TestGetAudio:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/audio/nonexistent_piece_xyz")
        assert r.status_code == 404
