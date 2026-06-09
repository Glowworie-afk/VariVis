"""
API tests:
  GET /api/midi/notes/{file_name}
  GET /api/midi/{file_name}

Both routes return {"matched": false} (not 404) when no MIDI file is found.
"""


class TestMidiNotes:
    def test_200_when_no_midi_found(self, client):
        r = client.get("/api/midi/notes/nonexistent_piece_xyz")
        assert r.status_code == 200

    def test_matched_false_when_no_midi(self, client):
        r = client.get("/api/midi/notes/nonexistent_piece_xyz")
        assert r.json()["matched"] is False

    def test_message_present_when_unmatched(self, client):
        r = client.get("/api/midi/notes/nonexistent_piece_xyz")
        assert "message" in r.json()

    def test_n_variations_param_accepted(self, client):
        r = client.get("/api/midi/notes/nonexistent_piece_xyz?n_variations=5")
        assert r.status_code == 200


class TestMidiAnalysis:
    def test_200_when_no_midi_found(self, client):
        r = client.get("/api/midi/nonexistent_piece_xyz")
        assert r.status_code == 200

    def test_matched_false_when_no_midi(self, client):
        r = client.get("/api/midi/nonexistent_piece_xyz")
        assert r.json()["matched"] is False

    def test_file_name_echoed_in_response(self, client):
        r = client.get("/api/midi/nonexistent_piece_xyz")
        assert r.json()["file_name"] == "nonexistent_piece_xyz"

    def test_n_variations_param_accepted(self, client):
        r = client.get("/api/midi/nonexistent_piece_xyz?n_variations=3")
        assert r.status_code == 200
