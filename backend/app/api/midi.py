"""
app/api/midi.py
────────────────
Routes: MIDI piano roll and per-variation structural analysis.
"""

from fastapi import APIRouter, HTTPException

from app.services.midi import find_midi_file, parse_midi_analysis, read_midi_roll

router = APIRouter()


@router.get("/api/midi/notes/{file_name}")
def get_midi_notes(file_name: str, n_variations: "int | None" = None):
    """Return raw MIDI note list + segment boundaries for piano-roll rendering."""
    midi_path = find_midi_file(file_name)
    if midi_path is None:
        return {"matched": False, "message": f"No MIDI found for '{file_name}'"}
    try:
        return read_midi_roll(midi_path, file_name, n_variations)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.get("/api/midi/{file_name}")
def get_midi_analysis(file_name: str, n_variations: "int | None" = None):
    """Fuzzy-match file_name → TV_MIDI/, return per-variation structural analysis."""
    midi_path = find_midi_file(file_name)
    if midi_path is None:
        return {
            "matched":   False,
            "file_name": file_name,
            "message":   f"No matching MIDI found for '{file_name}' in TV_MIDI/",
        }
    try:
        result = parse_midi_analysis(midi_path, n_variations=n_variations)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    result["file_name"] = file_name
    return result
