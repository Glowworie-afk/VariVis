"""
API tests:
  POST /api/upload/process
  GET  /api/upload/temp_pdf/{temp_name}
  DELETE /api/upload/temp/{temp_name}
"""

import io
import json


class TestUploadProcess:
    def test_400_when_no_files_provided(self, client):
        r = client.post("/api/upload/process",
                        data={"piece_name": "Test", "boundaries": ""})
        assert r.status_code == 400

    def test_400_error_message_mentions_requirement(self, client):
        r = client.post("/api/upload/process",
                        data={"piece_name": "Test", "boundaries": ""})
        assert "musicxml" in r.json()["detail"].lower() or \
               "audio"    in r.json()["detail"].lower()

    def test_400_when_piece_name_missing(self, client):
        # piece_name is required (Form(...))
        dummy = io.BytesIO(b"fake")
        r = client.post("/api/upload/process",
                        files={"musicxml": ("test.mxl", dummy, "application/octet-stream")})
        assert r.status_code == 422  # FastAPI validation error

    def test_mxl_only_succeeds(self, client, monkeypatch, tmp_path):
        """Uploading only an MXL file should return 200 with symbolic views."""
        # Patch dirs so nothing is written to real filesystem
        monkeypatch.setattr("app.api.upload.MUSICXML_DIR",    tmp_path)
        monkeypatch.setattr("app.api.upload.IMSLP_DIR",       tmp_path)
        monkeypatch.setattr("app.api.upload.TEMP_FEATURE_DIR", tmp_path)

        # Minimal MXL = zip containing a stub XML
        import zipfile, io as _io
        buf = _io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("score.xml",
                       '<?xml version="1.0"?>'
                       '<score-partwise version="3.1">'
                       '<part-list/>'
                       '</score-partwise>')
        mxl_bytes = buf.getvalue()

        # Patch parse_mxl_symbolic + build_score_contours to avoid real music21
        monkeypatch.setattr("app.api.upload.parse_mxl_symbolic",  lambda _: None)
        monkeypatch.setattr("app.api.upload.build_score_contours", lambda _: None)
        monkeypatch.setattr("app.api.upload.extract_mxl_pitch_contour", lambda _: [])

        r = client.post(
            "/api/upload/process",
            data={"piece_name": "Test Piece", "boundaries": ""},
            files={"musicxml": ("test.mxl", _io.BytesIO(mxl_bytes),
                                "application/octet-stream")},
        )
        assert r.status_code == 200
        data = r.json()
        assert "temp_name" in data
        assert data["temp_name"].startswith("temp_")
        assert "available_views" in data


class TestTempPdf:
    def test_400_for_name_without_temp_prefix(self, client):
        r = client.get("/api/upload/temp_pdf/regular_name")
        assert r.status_code == 400

    def test_404_for_valid_temp_name_with_no_file(self, client):
        r = client.get("/api/upload/temp_pdf/temp_nonexistent_xyz")
        assert r.status_code == 404


class TestDeleteTemp:
    def test_400_for_name_without_temp_prefix(self, client):
        r = client.delete("/api/upload/temp/regular_piece_name")
        assert r.status_code == 400

    def test_200_for_valid_temp_name_even_when_no_files(self, client):
        # DELETE should succeed gracefully even if files don't exist
        r = client.delete("/api/upload/temp/temp_nonexistent_xyz")
        assert r.status_code == 200

    def test_delete_cleans_up_feature_file(self, client, monkeypatch, tmp_path):
        feat_file = tmp_path / "temp_testpiece.json"
        feat_file.write_text(json.dumps({"metadata": {}}))
        monkeypatch.setattr("app.api.upload.TEMP_FEATURE_DIR", tmp_path)
        monkeypatch.setattr("app.api.upload.MUSICXML_DIR",     tmp_path)
        monkeypatch.setattr("app.api.upload.IMSLP_DIR",        tmp_path)
        assert feat_file.exists()
        r = client.delete("/api/upload/temp/temp_testpiece")
        assert r.status_code == 200
        assert not feat_file.exists()
