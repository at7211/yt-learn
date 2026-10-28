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
from pipeline.intro import make_intro
from pipeline.llm import ClaudeCliProvider, CodexCliProvider
from pipeline.schema import VIDEO_ID_RE, validate_lesson, validate_raw
from pipeline.segment import finalize_cues, make_cues
from pipeline.vocab import pick_vocab
from pipeline.words import normalize_words

DEFAULT_MODEL = "claude-sonnet-5-5"


# Progress is reported in weighted work units: one per segmentation chunk, VOCAB_UNITS for the
# vocabulary call, INTRO_UNITS for the intro card. web/progress.js derives the chunk count from these.
VOCAB_UNITS = 2
INTRO_UNITS = 1


def build_lesson(raw: dict, provider, limit_seconds: float | None = None,
                 model_label: str = "default", prompt_version: int = 1,
                 progress=None) -> tuple[dict, dict]:
    """Return ``(lesson, stats)``; stats has chunks, fallback_chunks, vocab_failed, intro_failed.

    ``progress(phase, done, total)`` is called after each chunk ("segment"), when the vocabulary
    call starts ("vocab"), when the intro call starts ("intro") and at the end ("finish")."""
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
    stats = {"chunks": 0, "fallback_chunks": 0, "vocab_failed": 0, "intro_failed": 0}
    chunks = list(chunk_words(words))
    total = len(chunks) + VOCAB_UNITS + INTRO_UNITS
    report = progress or (lambda phase, done, total: None)
    cues = []
    for chunk in chunks:
        stats["chunks"] += 1
        cues += make_cues(words, chunk, provider, stats)
        report("segment", stats["chunks"], total)
    cues = finalize_cues(cues, words)
    report("vocab", len(chunks), total)
    vocab = pick_vocab(cues, words, provider, stats=stats)
    report("intro", len(chunks) + VOCAB_UNITS, total)
    intro = make_intro({"title": raw["title"], "channel": raw["channel"], "duration": duration}, cues, provider, stats)
    report("finish", total, total)
    lesson = {
        "videoId": raw["videoId"], "title": raw["title"], "channel": raw["channel"],
        "duration": duration, "lang": raw["lang"],
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "model": model_label, "promptVersion": prompt_version, "coveredSeconds": covered,
        "words": words, "cues": cues, "vocab": vocab,
    }
    if intro is not None:
        lesson["intro"] = intro
    return lesson, stats


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


PROVIDERS = {"claude": ClaudeCliProvider, "codex": CodexCliProvider}


def _default_provider(model, cache_dir, provider="claude"):
    return PROVIDERS[provider](model=model, cache_dir=cache_dir)


def progress_writer(path: Path):
    """Return a progress callback that atomically rewrites ``path`` as JSON; write errors are ignored."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")

    def write(phase, done, total):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps({"phase": phase, "done": done, "total": total}), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            tmp.unlink(missing_ok=True)
    return write


def main(argv=None, data_dir: Path | str = "data", provider_factory=_default_provider) -> int:
    ap = argparse.ArgumentParser(prog="python3 -m pipeline.build")
    ap.add_argument("video_id")
    ap.add_argument("--limit-seconds", type=float, default=None)
    ap.add_argument("--provider", choices=sorted(PROVIDERS), default=os.environ.get("YTLEARN_PROVIDER") or "claude",
                    help="which logged-in CLI answers the prompts (env YTLEARN_PROVIDER); default claude")
    ap.add_argument("--model", default=None, help=f"model name for the provider; claude defaults to {DEFAULT_MODEL}, codex to its own config")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--progress-file", default=os.environ.get("YTLEARN_PROGRESS_FILE") or None,
                    help="write {phase, done, total} JSON here as the build advances (env YTLEARN_PROGRESS_FILE)")
    args = ap.parse_args(argv)
    if args.model is None and args.provider == "claude":
        args.model = DEFAULT_MODEL
    model_label = args.model if args.provider == "claude" else f"codex:{args.model or 'default'}"
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
    provider = (provider_factory(args.model, data / "cache" / vid, args.provider) if args.provider != "claude"
                else provider_factory(args.model, data / "cache" / vid))  # the two-argument form keeps old factories working
    try:
        lesson, stats = build_lesson(raw, provider, args.limit_seconds, model_label=model_label,
                                     prompt_version=getattr(provider, "prompt_version", 1),
                                     progress=progress_writer(args.progress_file) if args.progress_file else None)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if stats["chunks"] and stats["fallback_chunks"] == stats["chunks"]:
        print("所有切句呼叫都失敗（請確認 claude CLI 已登入）；未寫入 lesson", file=sys.stderr)
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
          f"fallback_chunks={stats['fallback_chunks']}/{stats['chunks']} "
          f"vocab_status={'skipped' if stats['vocab_failed'] else 'ok'} "
          f"intro={'failed' if stats['intro_failed'] else 'ok'} "
          f"llm_calls={getattr(provider, 'calls', 0)} cache_hits={getattr(provider, 'cache_hits', 0)} "
          f"seconds={time.monotonic() - t0:.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
