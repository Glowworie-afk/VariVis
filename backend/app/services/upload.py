"""
app/services/upload.py
───────────────────────
Utilities for parsing user-supplied upload parameters.

Used by:
  - api/upload.py
"""


def mmss_to_sec(value: float) -> float:
    """Convert MM.SS annotation format (e.g. 1.41 = 1 min 41 s) to seconds."""
    minutes = int(value)
    seconds = round((value - minutes) * 100, 1)
    return float(minutes * 60 + seconds)


def parse_boundaries(raw: str) -> list[float]:
    """Parse a comma-separated MM.SS boundary string into sorted seconds."""
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    secs: list[float] = []
    for p in parts:
        try:
            secs.append(mmss_to_sec(float(p)))
        except ValueError:
            pass
    return sorted(secs)


def auto_labels(n_segments: int) -> list[str]:
    """Generate default segment labels: T, V1, V2, …"""
    return ["T"] + [f"V{i}" for i in range(1, n_segments)]
