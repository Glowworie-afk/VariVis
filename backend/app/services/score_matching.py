"""
app/services/score_matching.py
────────────────────────────────
IMSLP PDF fuzzy-matching via catalog-number extraction.

Used by:
  - api/score.py  (get_score_pdf, match_score)
"""

import difflib
import re
from pathlib import Path

from app.core.config import IMSLP_DIR


def extract_catalog_numbers(text: str) -> dict:
    """
    Extract all music catalog numbers from a string.
    Returns dict with keys: kv, woo, op, hob, composer

    Handles both underscore-delimited filenames and natural-language strings:
      'WAMozart_K265_1'                    → { kv: '265', composer: 'mozart' }
      'LBeethoven_OP34_1'                  → { op: '34',  composer: 'beethoven' }
      'LBeethoven_WOO67_2'                 → { woo: '67', composer: 'beethoven' }
      'JHaydn_XVII5_1'                     → { hob: '17_5', composer: 'haydn' }
      'Beethoven - 6 Variations, Op. 34'   → { op: '34',  composer: 'beethoven' }
      'Wolfgang Amadeus Mozart: ... K.265' → { kv: '265', composer: 'mozart' }
    """
    nums: dict = {}
    t = text.upper().replace("_", " ")

    m = re.search(r'\bK\.?V?\.?\s*(\d+)', t)
    if m:
        nums['kv'] = m.group(1)

    m = re.search(r'\bWO+\.?\s*(\d+)', t)
    if m:
        nums['woo'] = m.group(1)

    m = re.search(r'\bOP(?:US)?\.?\s*(\d+)', t)
    if m:
        nums['op'] = m.group(1)

    m = re.search(r'(?:HOB(?:\.|\s+)?)?XVII[:./ ]?\s*(\d+)', t)
    if m:
        nums['hob'] = f'17_{m.group(1)}'

    for name in ('MOZART', 'BEETHOVEN', 'HAYDN', 'SCHUBERT', 'BRAHMS',
                 'CHOPIN', 'LISZT', 'SCHUMANN', 'HANDEL', 'BACH',
                 'DVORAK', 'RUBINSTEIN', 'RACHMANINOFF', 'GLAZUNOV',
                 'JANACEK', 'EIGES'):
        if name in t:
            nums['composer'] = name.lower()
            break

    return nums


def best_imslp_match(file_name: str, music_name: str) -> tuple[str | None, float, list[str]]:
    """
    Fuzzy-match (file_name, music_name) → best PDF in IMSLP_DIR.

    Strategy:
      1. Extract catalog numbers (K/KV, WoO, Op, Hob) from both query AND each PDF name.
      2. If a catalog number matches exactly → strong bonus (0.6).
      3. Also check composer name match → small bonus (0.1).
      4. Fallback: difflib sequence ratio on normalised strings.
    Returns (best_filename, confidence_score, all_pdf_names).
    """
    if not IMSLP_DIR.exists():
        return None, 0.0, []
    pdfs = [f.name for f in sorted(IMSLP_DIR.iterdir()) if f.suffix.lower() == '.pdf']
    if not pdfs:
        return None, 0.0, []

    query_text = f"{file_name} {music_name}"
    q_nums = extract_catalog_numbers(query_text)

    def _norm(s: str) -> str:
        s = re.sub(r'IMSLP\d+[-_]?', '', s, flags=re.IGNORECASE)
        s = re.sub(r'PMLP\d+[-_]?', '', s, flags=re.IGNORECASE)
        s = re.sub(r'[_\-\.]+', ' ', s)
        return s.lower().strip()

    q_norm = _norm(query_text)

    best_score = -1.0
    best_file: str | None = None

    for pdf in pdfs:
        stem   = pdf[:-4]
        p_nums = extract_catalog_numbers(stem)
        p_norm = _norm(stem)

        score = difflib.SequenceMatcher(None, q_norm, p_norm).ratio()

        for key in ('kv', 'woo', 'op', 'hob'):
            if key in q_nums and key in p_nums and q_nums[key] == p_nums[key]:
                score = min(score + 0.6, 1.0)
                break

        if 'composer' in q_nums and 'composer' in p_nums:
            if q_nums['composer'] == p_nums['composer']:
                score = min(score + 0.1, 1.0)
            else:
                score = score * 0.2

        if score > best_score:
            best_score = score
            best_file = pdf

    return best_file, round(best_score, 3), pdfs
