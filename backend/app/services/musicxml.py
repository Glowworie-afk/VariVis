"""
app/services/musicxml.py
─────────────────────────
MusicXML file lookup, section parsing, and local score corpus.

Used by:
  - api/musicvis.py   (section/chord/skeleton endpoints)
  - app/services/midi.py  (section boundaries for MIDI analysis)
"""

import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from app.core.config import MUSICXML_DIR

def find_musicxml(file_name: str) -> "Path | None":
    """Match file_name to a .mxl/.xml file in MUSICXML_DIR.

    Accepts plain stems, filenames with extension, and piece names with version suffix.
    """
    base  = Path(file_name).stem if "." in file_name else file_name
    stems = [base, re.sub(r"_\d+$", "", base)]
    for stem in stems:
        stem = stem.replace(" ", "_")
        for ext in (".mxl", ".xml", ".musicxml"):
            p = MUSICXML_DIR / f"{stem}{ext}"
            if p.exists():
                return p
    for f in MUSICXML_DIR.iterdir():
        if f.suffix.lower() in (".mxl", ".xml", ".musicxml"):
            for stem in stems:
                if f.stem.lower() == stem.replace(" ", "_").lower():
                    return f
    return None


def extract_mxl(path: Path) -> bytes:
    """Extract the score XML bytes from an .mxl (ZIP) file."""
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        if "META-INF/container.xml" in names:
            container = zf.read("META-INF/container.xml")
            try:
                root = ET.fromstring(container)
                ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
                rf = root.find(".//c:rootfile", ns) or root.find(".//rootfile")
                if rf is not None:
                    rootfile_path = rf.get("full-path")
                    if rootfile_path and rootfile_path in names:
                        return zf.read(rootfile_path)
            except ET.ParseError:
                pass
        for n in names:
            if n.endswith(".xml") and not n.startswith("META-INF"):
                return zf.read(n)
        return zf.read(names[0])


_SECTION_SKIP = (
    "m.s.", "m.d.", "destra", "sinistra", "ritard", "fine", "segue",
    "rit.", "poco", "sempre", "cresc", "decresc", "dim.", "sfz", "fz",
    "p.", "dolce", "legato", "staccato", "andantino", "andante",
    "allegro", "adagio", "moderato", "presto", "vivace", "largo", "lento",
)

_ROMAN = {
    "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6,
    "vii": 7, "viii": 8, "ix": 9, "x": 10, "xi": 11, "xii": 12,
}


def get_musicxml_sections(file_name: str) -> "list[tuple[str, int]]":
    """
    Parse MusicXML for file_name and return section boundaries as
    [(label, measure_index), ...] sorted by measure index.
    Returns [] if no MusicXML found, music21 unavailable, or <2 sections detected.
    """
    path = find_musicxml(file_name)
    if path is None:
        return []
    try:
        import music21
    except ImportError:
        return []

    try:
        if path.suffix.lower() == ".mxl":
            xml_bytes = extract_mxl(path)
            score = music21.converter.parseData(xml_bytes, format="musicxml")
        else:
            score = music21.converter.parse(str(path))
    except Exception:
        return []

    if not score.parts:
        return []

    part     = score.parts[0]
    measures = list(part.getElementsByClass("Measure"))

    offset_to_idx: dict[float, int] = {}
    for idx, m in enumerate(measures):
        off = float(m.offset)
        if off not in offset_to_idx:
            offset_to_idx[off] = idx

    raw: list[tuple[float, str]] = []
    seen: set[float] = set()
    for m in measures:
        off = float(m.offset)
        if off in seen:
            continue
        seen.add(off)
        for el in m.flatten():
            if isinstance(el, (music21.expressions.RehearsalMark,
                                music21.expressions.TextExpression)):
                content = (el.content if hasattr(el, "content") else str(el)).strip()
                if not content:
                    continue
                low = content.lower()
                if any(k in low for k in _SECTION_SKIP):
                    continue
                if low.startswith(("tema", "var", "theme", "coda",
                                   "finale", "minore", "maggiore", "trio")):
                    raw.append((off, content))
                    break

    raw.sort(key=lambda x: x[0])

    if raw and offset_to_idx.get(raw[0][0], 0) > 0:
        raw.insert(0, (0.0, "Tema"))

    if len(raw) < 2:
        return []

    def _roman_to_int(s: str) -> "int | None":
        return _ROMAN.get(s.strip().lower())

    result = []
    for off, label in raw:
        idx = offset_to_idx.get(off, 0)
        low = label.lower()
        if low in ("tema", "theme"):
            norm = "Theme"
        elif low.startswith("coda"):
            norm = "Coda"
        else:
            m2 = re.search(r"(\d+)", label)
            if m2:
                norm = f"Var.{int(m2.group(1)):02d}"
            else:
                m3 = re.search(r"[.\s]+([IVXivx]+)\s*$", label)
                n  = _roman_to_int(m3.group(1)) if m3 else None
                norm = f"Var.{n:02d}" if n else label
        result.append((norm, idx))

    return result
