#!/usr/bin/env python3
"""
Myung-Tech preprocessing engine: select latest parseable file, convert to markdown.
"""

import sys
import traceback
from datetime import datetime
from pathlib import Path

try:
    from markitdown import MarkItDown
except Exception as exc:  # pragma: no cover
    print(f"[FATAL] Failed to import markitdown: {exc}", file=sys.stderr)
    sys.exit(1)

BASE_DIR = Path(__file__).resolve().parent
EXCLUDED_NAMES = {"venv"}
EXCLUDED_EXTS = {".py", ".md", ".txt"}
PARSEABLE_EXTS = {
    ".pdf",
    ".xlsx",
    ".xls",
    ".docx",
    ".doc",
    ".pptx",
    ".ppt",
    ".csv",
    ".json",
    ".xml",
    ".html",
    ".htm",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".tiff",
    ".zip",
}


def log_error(message: str) -> None:
    ts = datetime.now().isoformat(timespec="seconds")
    line = f"[{ts}] {message}\n"
    try:
        with open(BASE_DIR / "parser.log", "a", encoding="utf-8", errors="replace") as f:
            f.write(line)
    except Exception:
        pass
    print(line, end="", file=sys.stderr)


def find_latest_input() -> Path | None:
    best = None
    best_mtime = -1.0
    for path in BASE_DIR.iterdir():
        if path.name in EXCLUDED_NAMES:
            continue
        if not path.is_file():
            continue
        if path.suffix.lower() in EXCLUDED_EXTS:
            continue
        if path.suffix.lower() not in PARSEABLE_EXTS:
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError as exc:
            log_error(f"Stat failed for {path}: {exc}")
            continue
        if mtime > best_mtime:
            best_mtime = mtime
            best = path
    return best


def main() -> int:
    source = find_latest_input()
    if source is None:
        msg = "No parseable source file found after filtering .py/.md/.txt and 'venv'."
        print(msg, file=sys.stderr)
        log_error(msg)
        return 2

    out_name = f"parsed_{source.name}.md"
    out_path = BASE_DIR / out_name

    try:
        converter = MarkItDown()
        result = converter.convert(str(source))
        text = getattr(result, "text_content", None)
        if text is None and isinstance(result, dict):
            text = result.get("text_content", "")
        if text is None:
            text = str(result)
        out_path.write_text(text, encoding="utf-8")
        print(str(out_path))
        return 0
    except Exception as exc:
        err = f"Conversion failed for {source.name}: {exc}\n{traceback.format_exc()}"
        log_error(err)
        return 1


if __name__ == "__main__":
    sys.exit(main())
