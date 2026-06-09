"""
Shared fixtures for API integration tests.

client      – session-scoped TestClient (no real server needed)
sample_feature – minimal valid feature JSON dict
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app

# Minimal feature JSON that satisfies all consumers of /api/features/{file_name}
SAMPLE_FEATURE: dict = {
    "metadata": {
        "file_name":       "WAMozart_K265_1",
        "music_name":      "Mozart K265 Variation 1",
        "extracted_at":    "2026-01-01T00:00:00",
        "available_views": ["corpus_view"],
    },
    "segments": [
        {
            "label":                  "T",
            "start_sec":              0.0,
            "end_sec":                30.0,
            "chroma_cof":             [round(1 / 12, 6)] * 12,
            "chroma_chromatic":       [round(1 / 12, 6)] * 12,
            "dominant_pitch":         {"name": "C", "cof_index": 0},
            "rms_mean":               0.1,
            "rms_std":                0.01,
            "rms_max":                0.2,
            "dynamic_range_db":       10.0,
            "mfcc_mean":              [0.0] * 13,
            "mfcc_std":               [0.1] * 13,
            "spectral_centroid_mean": 2000.0,
            "onset_density":          5.0,
            "tempo":                  120.0,
            "rhythm_regularity":      0.7,
        }
    ],
}


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def sample_feature() -> dict:
    import copy
    return copy.deepcopy(SAMPLE_FEATURE)


@pytest.fixture
def feature_dir(tmp_path, sample_feature, monkeypatch):
    """
    Create a temp feature dir containing one sample JSON file,
    then patch the FEATURE_DIR reference in app.api.pieces so that
    GET /api/features/{file_name} hits the temp dir.
    """
    feat_path = tmp_path / "WAMozart_K265_1.json"
    feat_path.write_text(json.dumps(sample_feature), encoding="utf-8")
    monkeypatch.setattr("app.api.pieces.FEATURE_DIR", tmp_path)
    return tmp_path
