"""
extract_features.py  (CLI wrapper)
===================================
音频特征提取 CLI 入口。核心逻辑已移至 app/services/audio.py。

用法:
    python extract_features.py WAMozart_K265_1
    python extract_features.py --all
    python extract_features.py WAMozart_K265_1 --frames 128 --sr 22050
"""

import argparse
import sys
from pathlib import Path

# Allow running as a script from backend/ without installing the package
sys.path.insert(0, str(Path(__file__).parent))

from app.services.audio import load_annotation, process_file, save_features


def main():
    parser = argparse.ArgumentParser(description="VariVis 音频特征提取")
    parser.add_argument("target", nargs="?", help="file_name，如 WAMozart_K265_1")
    parser.add_argument("--all",    action="store_true", help="处理 annotation 中所有条目")
    parser.add_argument("--frames", type=int, default=64,   help="压缩帧数（默认64）")
    parser.add_argument("--sr",     type=int, default=None, help="重采样率（默认保持原始）")
    args = parser.parse_args()

    if args.all:
        df      = load_annotation()
        targets = df["file_name (folderName_number)"].dropna().tolist()
        print(f"共 {len(targets)} 个录音文件待处理")
        success, failed = 0, []
        for t in targets:
            try:
                data = process_file(str(t), args.frames, args.sr)
                save_features(data, str(t))
                success += 1
            except Exception as e:
                print(f"  ✗ {t}: {e}")
                failed.append(str(t))
        print(f"\n完成：{success} 成功，{len(failed)} 失败")
        if failed:
            print("失败列表:", failed)

    elif args.target:
        data = process_file(args.target, args.frames, args.sr)
        save_features(data, args.target)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
