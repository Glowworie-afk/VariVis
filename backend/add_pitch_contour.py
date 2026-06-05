"""
add_pitch_contour.py  (CLI wrapper)
=====================================
为已有的特征 JSON 补充 pYIN 旋律轮廓 + 调性检测 + 节拍对齐。
核心逻辑已移至 app/services/pitch_contour.py。

用法:
    python add_pitch_contour.py WAMozart_K265_1
    python add_pitch_contour.py --all
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.core.config import FEATURE_DIR
from app.services.pitch_contour import process_file


def main():
    parser = argparse.ArgumentParser(description="为已有JSON补充pYIN旋律轮廓+KS调性检测+节拍对齐")
    parser.add_argument("target", nargs="?", help="file_name，如 WAMozart_K265_1")
    parser.add_argument("--all", action="store_true", help="处理 features/ 下所有 JSON")
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
