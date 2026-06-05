"""
add_score_pitch.py  (CLI wrapper)
===================================
从 MusicXML 提取乐谱音高轮廓，写入已有的特征 JSON。
核心逻辑已移至 app/services/score_pitch.py。

用法:
    python add_score_pitch.py WAMozart_K265_1
    python add_score_pitch.py --all
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.core.config import FEATURE_DIR
from app.services.score_pitch import process_file


def main():
    parser = argparse.ArgumentParser(
        description="Add score-pitch contour (MusicXML, shared across all performers)"
    )
    parser.add_argument("target", nargs="?", help="file_name, e.g. WAMozart_K265_1")
    parser.add_argument("--all", action="store_true", help="process all feature JSONs")
    args = parser.parse_args()

    if args.all:
        for p in sorted(FEATURE_DIR.glob("*.json")):
            process_file(p.stem)
    elif args.target:
        process_file(args.target)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
