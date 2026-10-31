"""Build a lesson (data/lessons/<id>.json) from captured raw captions."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from pipeline.chunk import chunk_words
from pipeline.intro import make_intro
from pipeline.llm import CODEX_EFFORT, EFFORTS, ClaudeCliProvider, CodexCliProvider
from pipeline.ids import LESSON_ID_RE
from pipeline.schema import validate_lesson, validate_raw
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
                 progress=None, workers: int | None = None, effort: str = "default") -> tuple[dict, dict]:
    """Return ``(lesson, stats)``; stats has chunks, fallback_chunks, vocab_failed, intro_failed.

    ``progress(phase, done, total)`` is called after each chunk ("segment"), when the vocabulary
    call starts ("vocab"), when the intro call starts ("intro") and at the end ("finish").

    Chunks are independent, so ``workers`` of them are segmented at once (default
    ``$YTLEARN_WORKERS`` or 4); cues come back in chunk order regardless of completion order."""
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
    if workers is None:
        workers = _workers_from_env()
    done = 0

    def segment(chunk):
        st = {"fallback_chunks": 0}
        return make_cues(words, chunk, provider, st), st["fallback_chunks"]

    results = []
    if workers <= 1:
        for chunk in chunks:
            results.append(segment(chunk))
            done += 1
            report("segment", done, total)
    else:
        with ThreadPoolExecutor(max_workers=min(workers, len(chunks))) as pool:
            futures = [pool.submit(segment, c) for c in chunks]
            for f in futures:  # wait in chunk order; progress still counts every finished chunk
                f.result()
                done = sum(1 for x in futures if x.done())
                report("segment", done, total)
            results = [f.result() for f in futures]
    cues = []
    for chunk_cues, fell_back in results:
        stats["chunks"] += 1
        stats["fallback_chunks"] += fell_back
        cues += chunk_cues
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
        "model": model_label, "effort": effort, "promptVersion": prompt_version, "coveredSeconds": covered,
        "words": words, "cues": cues, "vocab": vocab,
    }
    for k in ("source", "sourceUrl"):  # optional; validated by validate_raw/validate_lesson
        if k in raw:
            lesson[k] = raw[k]
    if intro is not None:
        lesson["intro"] = intro
    return lesson, stats


def _workers_from_env() -> int:
    try:
        return max(1, int(os.environ.get("YTLEARN_WORKERS", "4")))
    except ValueError:
        return 4


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


PROVIDERS = {"claude": ClaudeCliProvider, "codex": CodexCliProvider}


def _default_provider(model, cache_dir, provider="claude", effort=None):
    return PROVIDERS[provider](model=model, cache_dir=cache_dir, effort=effort)


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
    ap.add_argument("--model", default=None,
                    help=f"model name for the provider; claude defaults to $YTLEARN_MODEL or {DEFAULT_MODEL}, "
                         "codex to its own config (YTLEARN_MODEL is ignored for codex)")
    ap.add_argument("--effort", choices=("default", *EFFORTS), default=os.environ.get("YTLEARN_EFFORT") or None,
                    help="reasoning effort (env YTLEARN_EFFORT); default = the CLI's own; codex caps it at high")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--progress-file", default=os.environ.get("YTLEARN_PROGRESS_FILE") or None,
                    help="write {phase, done, total} JSON here as the build advances (env YTLEARN_PROGRESS_FILE)")
    args = ap.parse_args(argv)
    if args.provider not in PROVIDERS:  # argparse does not check an env-derived default against choices
        ap.error(f"unknown provider {args.provider!r} (YTLEARN_PROVIDER); choose one of {', '.join(sorted(PROVIDERS))}")
    if args.effort is not None and args.effort not in ("default", *EFFORTS):  # env default, unchecked by argparse
        ap.error(f"unknown effort {args.effort!r} (YTLEARN_EFFORT); choose one of default, {', '.join(EFFORTS)}")
    if args.effort == "default":
        args.effort = None
    if args.model is None and args.provider == "claude":
        args.model = os.environ.get("YTLEARN_MODEL") or DEFAULT_MODEL  # codex keeps its own config's model
    effective_effort = (CODEX_EFFORT[args.effort] if args.provider == "codex" else args.effort) if args.effort else None
    workers = _workers_from_env()
    model_label = args.model if args.provider == "claude" else f"codex:{args.model or 'default'}"
    data = Path(data_dir)
    vid = args.video_id
    if not LESSON_ID_RE.fullmatch(vid):
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

    print(f"settings: provider={args.provider} model={args.model or 'default'} "
          f"effort={effective_effort or 'default'} workers={workers}", flush=True)
    t0 = time.monotonic()
    # Old two-argument factories keep working: the provider name and effort are only passed when needed.
    extra = {"effort": args.effort} if args.effort else {}
    provider = (provider_factory(args.model, data / "cache" / vid, args.provider, **extra) if args.provider != "claude"
                else provider_factory(args.model, data / "cache" / vid, **extra))
    try:
        lesson, stats = build_lesson(raw, provider, args.limit_seconds, model_label=model_label,
                                     prompt_version=getattr(provider, "prompt_version", 1),
                                     progress=progress_writer(args.progress_file) if args.progress_file else None,
                                     workers=workers, effort=effective_effort or "default")
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if stats["chunks"] and stats["fallback_chunks"] == stats["chunks"]:
        print(f"所有切句呼叫都失敗（請確認 {args.provider} CLI 已登入）；未寫入 lesson", file=sys.stderr)
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
