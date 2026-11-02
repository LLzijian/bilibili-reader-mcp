"""Reuse an existing moss-transcribe batch.py; emit timestamped NDJSON."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def srt_segments(text):
    pattern = re.compile(r"^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3}) --> (\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$")
    result = []
    for block in re.split(r"\n\s*\n", text.strip().replace("\r\n", "\n").lstrip("\ufeff")):
        lines = block.splitlines()
        if len(lines) < 3 or not lines[0].isdigit():
            raise ValueError("Invalid SRT block")
        match = pattern.fullmatch(lines[1])
        if not match:
            raise ValueError("Invalid SRT timing")
        h, m, s, ms, eh, em, es, ems = map(int, match.groups())
        start = h * 3600 + m * 60 + s + ms / 1000
        end = eh * 3600 + em * 60 + es + ems / 1000
        content = " ".join(lines[2:]).strip()
        if content:
            result.append({"type":"segment", "start":start, "end":end, "text":content})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    args = parser.parse_args()
    audio = args.audio.resolve(strict=True)
    subprocess.run([sys.executable, str(args.script.resolve(strict=True)), "--settings",
                    str(args.settings.resolve(strict=True)), "--input", str(audio), "--format", "srt"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   env=dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8"),
                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    captions = audio.with_suffix(".srt")
    if captions.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Subtitle size exceeded")
    records = srt_segments(captions.read_text(encoding="utf-8-sig"))
    for record in [{"type":"meta", "language":"zh"}, *records, {"type":"done", "count":len(records)}]:
        print(json.dumps(record, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
