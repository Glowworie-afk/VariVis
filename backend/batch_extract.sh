#!/usr/bin/env bash
# =====================================================================
# batch_extract.sh
# 批量提取海顿/贝多芬/莫扎特音频特征
#
# 用法（在 backend/ 目录下，激活 venv 后运行）：
#   cd /path/to/VariVis/backend
#   source .venv/bin/activate
#   bash batch_extract.sh
#
# 或者不激活 venv，直接指定 Python 路径：
#   bash batch_extract.sh /path/to/.venv/bin/python
#
# 支持断点续传：已有 .json 文件的条目自动跳过。
# 进度日志写入 batch_extract.log（实时追加）。
# =====================================================================

set -euo pipefail

# ── Python 可执行路径 ──────────────────────────────────────────────
PYTHON="${1:-python}"

# 优先使用 venv 内的 python（如果当前目录有 .venv）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [ -f "$VENV_PYTHON" ] && [ -x "$VENV_PYTHON" ]; then
  PYTHON="$VENV_PYTHON"
fi

echo "Using Python: $($PYTHON --version 2>&1)"
echo "Script dir : $SCRIPT_DIR"
echo

# ── 待提取列表 ────────────────────────────────────────────────────
TODO_FILE="$SCRIPT_DIR/todo_extract.txt"
FEATURES_DIR="$SCRIPT_DIR/features"
LOG="$SCRIPT_DIR/batch_extract.log"

if [ ! -f "$TODO_FILE" ]; then
  echo "ERROR: todo_extract.txt not found in $SCRIPT_DIR"
  exit 1
fi

TOTAL=$(wc -l < "$TODO_FILE" | tr -d ' ')
echo "Total files to process: $TOTAL"
echo "Log file: $LOG"
echo "$(date): Starting batch extraction of $TOTAL files" >> "$LOG"
echo

# ── 主循环 ────────────────────────────────────────────────────────
SUCCESS=0
SKIPPED=0
FAILED=0
FAILED_LIST=()

IDX=0
while IFS= read -r file_name || [ -n "$file_name" ]; do
  [ -z "$file_name" ] && continue
  IDX=$((IDX + 1))
  PERCENT=$(( IDX * 100 / TOTAL ))

  # 断点续传：两步都完成才算 done（检查 JSON 中是否有 pitch_contour 字段）
  JSON="$FEATURES_DIR/${file_name}.json"
  if [ -f "$JSON" ] && python -c "
import json, sys
with open('$JSON') as f:
    d = json.load(f)
segs = d.get('segments', [])
done = segs and all('pitch_contour' in s.get('features', {}) for s in segs)
sys.exit(0 if done else 1)
" 2>/dev/null; then
    printf "[%3d%%] SKIP  %s\n" "$PERCENT" "$file_name"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  printf "[%3d%%] %-40s " "$PERCENT" "$file_name"

  # Step 1: extract_features.py
  if ! "$PYTHON" "$SCRIPT_DIR/extract_features.py" "$file_name" >> "$LOG" 2>&1; then
    echo "FAIL (extract)"
    echo "$(date): FAIL extract $file_name" >> "$LOG"
    FAILED=$((FAILED + 1))
    FAILED_LIST+=("$file_name")
    continue
  fi

  # Step 2: add_pitch_contour.py
  if ! "$PYTHON" "$SCRIPT_DIR/add_pitch_contour.py" "$file_name" >> "$LOG" 2>&1; then
    echo "FAIL (pitch_contour)"
    echo "$(date): FAIL pitch_contour $file_name" >> "$LOG"
    FAILED=$((FAILED + 1))
    FAILED_LIST+=("$file_name")
    continue
  fi

  echo "OK"
  echo "$(date): OK $file_name" >> "$LOG"
  SUCCESS=$((SUCCESS + 1))

done < "$TODO_FILE"

# ── 汇总 ──────────────────────────────────────────────────────────
echo
echo "============================================"
echo "Batch extraction complete"
echo "  Success : $SUCCESS"
echo "  Skipped : $SKIPPED"
echo "  Failed  : $FAILED"
echo "============================================"
echo "$(date): Done — success=$SUCCESS skipped=$SKIPPED failed=$FAILED" >> "$LOG"

if [ ${#FAILED_LIST[@]} -gt 0 ]; then
  echo
  echo "Failed files:"
  for f in "${FAILED_LIST[@]}"; do
    echo "  $f"
  done
fi
