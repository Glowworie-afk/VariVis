"""
API tests:
  GET /api/musicvis/list
  GET /api/musicvis/xml/{file_name}
  GET /api/musicvis/sections/{file_name}
  GET /api/musicvis/chords/{file_name}
  GET /api/musicvis/skeleton/{file_name}
  GET /api/musicvis/ornaments/{file_name}
  GET /api/musicvis/chordtones/{file_name}
  GET /api/musicvis/harmonics/{file_name}
"""


class TestMusicvisList:
    def test_always_200(self, client):
        r = client.get("/api/musicvis/list")
        assert r.status_code == 200

    def test_returns_files_key(self, client):
        assert "files" in client.get("/api/musicvis/list").json()

    def test_files_is_list(self, client):
        assert isinstance(client.get("/api/musicvis/list").json()["files"], list)

    def test_with_mxl_in_dir(self, client, monkeypatch, tmp_path):
        # Create a fake .mxl file in a temp dir, patch MUSICXML_DIR
        (tmp_path / "WAMozart_K265.mxl").touch()
        (tmp_path / "readme.txt").touch()  # non-mxl file, should be ignored
        monkeypatch.setattr("app.core.config.MUSICXML_DIR", tmp_path)
        r = client.get("/api/musicvis/list")
        assert "WAMozart_K265" in r.json()["files"]
        assert "readme" not in r.json()["files"]


class TestMusicvisXml:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/musicvis/xml/nonexistent_piece_xyz")
        assert r.status_code == 404


class TestMusicvisSections:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/musicvis/sections/nonexistent_piece_xyz")
        assert r.status_code == 404


class TestMusicvisChords:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/musicvis/chords/nonexistent_piece_xyz")
        assert r.status_code == 404


class TestMusicvisSkeleton:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/musicvis/skeleton/nonexistent_piece_xyz")
        assert r.status_code == 404


class TestMusicvisOrnaments:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/musicvis/ornaments/nonexistent_piece_xyz")
        assert r.status_code == 404


class TestMusicvisChordtones:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/musicvis/chordtones/nonexistent_piece_xyz")
        assert r.status_code == 404


class TestMusicvisHarmonics:
    def test_404_for_nonexistent(self, client):
        r = client.get("/api/musicvis/harmonics/nonexistent_piece_xyz")
        assert r.status_code == 404
