"""Build a lesson (data/lessons/<id>.json) from captured raw captions."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

from pipeline.chunk import chunk_words
from pipeline.llm import ClaudeCliProvider
from pipeline.schema import VIDEO_ID_RE, validate_lesson, validate_raw
from pipeline.segment import finalize_cues, make_cues
from pipeline.vocab import pick_vocab
from pipeline.words import normalize_words

DEFAULT_MODEL = "claude-sonnet-5-5"


def build_lesson(raw: dict, provider, limit_seconds: float | None = None,
                 model_label: str = "default", prompt_version: int = 1) -> dict:
    errs = validate_raw(raw)
    if errs:
        raise ValueError("invalid raw capture: " + "; ".join(errs))
    duration = raw["duration"]
    words = normalize_words(raw["events"], duration)
    covered = duration
    if limit_seconds is not None:
        covered = min(limit_seconds, duration)
        words = [w for w in words if w["t"] < limit_seconds]
    if not words:
        raise ValueError("no words to build (empty after time limit)")
    cues = []
    for chunk in chunk_words(words):
        cues += make_cues(words, chunk, provider)
    cues = finalize_cues(cues, words)
    vocab = pick_vocab(cues, words, provider)
    return {
        "videoId": raw["videoId"], "title": raw["title"], "channel": raw["channel"],
        "duration": duration, "lang": raw["lang"],
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "model": model_label, "promptVersion": prompt_version, "coveredSeconds": covered,
        "words": words, "cues": cues, "vocab": vocab,
    }


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _default_provider(model, cache_dir):
    return ClaudeCliProvider(model=model, cache_dir=cache_dir)


def main(argv=None, data_dir: Path | str = "data", provider_factory=_default_provider) -> int:
    ap = argparse.ArgumentParser(prog="python3 -m pipeline.build")
    ap.add_argument("video_id")
    ap.add_argument("--limit-seconds", type=float, default=None)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    data = Path(data_dir)
    vid = args.video_id
    if not VIDEO_ID_RE.fullmatch(vid):
        print(f"error: invalid video id {vid!r}", file=sys.stderr)
        return 1
    raw_path = data / "raw" / f"{vid}.json"
    try:
        raw = _read_json(raw_path)
    except (OSError, ValueError) as e:
        print(f"error: cannot read {raw_path}: {e}", file=sys.stderr)
        return 1
    errs = validate_raw(raw)
    if errs:
        print("error: invalid raw capture:\n  " + "\n  ".join(errs), file=sys.stderr)
        return 1

    out_path = data / "lessons" / f"{vid}.json"
    is_preview = args.limit_seconds is not None and args.limit_seconds < raw["duration"]
    if is_preview and not args.force and out_path.exists():
        try:
            old = _read_json(out_path)
            full = old["coveredSeconds"] >= old["duration"]
        except (OSError, ValueError, KeyError, TypeError):
            full = False
        if full:
            print(f"error: {out_path} is a full lesson; refusing to overwrite it with a preview "
                  "(use --force)", file=sys.stderr)
            return 2

    t0 = time.monotonic()
    provider = provider_factory(args.model, data / "cache" / vid)
    try:
        lesson = build_lesson(raw, provider, args.limit_seconds, model_label=args.model,
                              prompt_version=getattr(provider, "prompt_version", 1))
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    errs = validate_lesson(lesson)
    if errs:
        print("error: lesson failed validation:\n  " + "\n  ".join(errs), file=sys.stderr)
        return 1
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(f"{out_path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(lesson, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, out_path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    print(f"cues={len(lesson['cues'])} vocab={len(lesson['vocab'])} "
          f"llm_calls={getattr(provider, 'calls', 0)} cache_hits={getattr(provider, 'cache_hits', 0)} "
          f"seconds={time.monotonic() - t0:.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
