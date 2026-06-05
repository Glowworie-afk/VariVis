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

from app.core.config import BASE_DIR, MUSICXML_DIR

SCORES_DIR = BASE_DIR / "scores"
SCORES_DIR.mkdir(exist_ok=True)

_SCORE_MAP: dict[str, str] = {
    # ── Beethoven WoO ──────────────────────────────────────────────────
    "LBeethoven_WOO28":  "beethoven_woo28",
    "LBeethoven_WOO40":  "beethoven_woo40",
    "LBeethoven_WOO45":  "beethoven_woo45",
    "LBeethoven_WOO63":  "beethoven_woo63",
    "LBeethoven_WOO64":  "beethoven_woo64",
    "LBeethoven_WOO65":  "beethoven_woo65",
    "LBeethoven_WOO66":  "beethoven_woo66",
    "LBeethoven_WOO67":  "beethoven_woo67",
    "LBeethoven_WOO68":  "beethoven_woo68",
    "LBeethoven_WOO69":  "beethoven_woo69",
    "LBeethoven_WOO70":  "beethoven_woo70",
    "LBeethoven_WOO71":  "beethoven_woo71",
    "LBeethoven_WOO72":  "beethoven_woo72",
    "LBeethoven_WOO73":  "beethoven_woo73",
    "LBeethoven_WOO74":  "beethoven_woo74",
    "LBeethoven_WOO75":  "beethoven_woo75",
    "LBeethoven_WOO76":  "beethoven_woo76",
    "LBeethoven_WOO77":  "beethoven_woo77",
    "LBeethoven_WOO78":  "beethoven_woo78",
    "LBeethoven_WOO79":  "beethoven_woo79",
    "LBeethoven_WOO80":  "beethoven_woo80",
    # ── Beethoven Op ───────────────────────────────────────────────────
    "LBeethoven_OP34":   "beethoven_op34",
    "LBeethoven_OP35":   "beethoven_op35",
    "LBeethoven_OP66":   "beethoven_op66",
    "LBeethoven_OP76":   "beethoven_op76",
    "LBeethoven_OP105":  "beethoven_op105",
    "LBeethoven_OP120":  "beethoven_op120",
    "LBeethoven_OP121":  "beethoven_op121a",
    # ── Mozart K ───────────────────────────────────────────────────────
    "WAMozart_K24":      "mozart_k24",
    "WAMozart_K25":      "mozart_k25",
    "WAMozart_K54":      "mozart_k54",
    "WAMozart_K179":     "mozart_k179",
    "WAMozart_K180":     "mozart_k180",
    "WAMozart_K264":     "mozart_k264",
    "WAMozart_K265":     "mozart_k265",
    "WAMozart_K352":     "mozart_k352",
    "WAMozart_K353":     "mozart_k353",
    "WAMozart_K354":     "mozart_k354",
    "WAMozart_K398":     "mozart_k398",
    "WAMozart_K455":     "mozart_k455",
    "WAMozart_K460":     "mozart_k460",
    "WAMozart_K500":     "mozart_k500",
    "WAMozart_K501":     "mozart_k501",
    "WAMozart_K573":     "mozart_k573",
    "WAMozart_K613":     "mozart_k613",
    # ── Haydn Hob.XVII ────────────────────────────────────────────────
    "JHaydn_XVII2":      "haydn_hob17_2",
    "JHaydn_XVII3":      "haydn_hob17_3",
    "JHaydn_XVII5":      "haydn_hob17_5",
    "JHaydn_XVII6":      "haydn_hob17_6",
    "JHaydn_XVII7":      "haydn_hob17_7",
}


def find_local_score(file_name: str) -> "Path | None":
    """
    Match file_name to a local .mxl/.xml/.musicxml in SCORES_DIR.
    e.g. 'WAMozart_K265_3' → 'WAMozart_K265' → 'mozart_k265'
    """
    base = re.sub(r"_\d+$", "", file_name)
    stem = _SCORE_MAP.get(base)
    if stem is None:
        return None
    for ext in (".mxl", ".xml", ".musicxml"):
        p = SCORES_DIR / f"{stem}{ext}"
        if p.exists():
            return p
    return None


def score_cache_path(file_name: str) -> Path:
    """Deterministic cache path in SCORES_DIR for converted XML."""
    base = re.sub(r"_\d+$", "", file_name)
    stem = _SCORE_MAP.get(base, base.lower())
    return SCORES_DIR / f"{stem}.cached.xml"


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
