"""Build a lesson (data/lessons/<id>.json) from captured raw captions."""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

from pipeline import cost, keys
from pipeline.chunk import chunk_words
from pipeline.intro import make_intro
from pipeline.llm import (CODEX_EFFORT, EFFORTS, AnthropicApiProvider, ClaudeCliProvider, CodexCliProvider,
                          OpenAiApiProvider, ProviderFatal)
from pipeline.ids import LESSON_ID_RE
from pipeline.schema import validate_lesson, validate_raw
from pipeline.segment import finalize_cues, make_cues
from pipeline.settings import PROVIDER_ALIASES
from pipeline.vocab import pick_vocab
from pipeline.words import normalize_words

DEFAULT_MODEL = "claude-sonnet-5-5"


# Progress is reported in weighted work units: one per segmentation chunk, VOCAB_UNITS for the
# vocabulary call, INTRO_UNITS for the intro card. web/progress.js derives the chunk count from these.
VOCAB_UNITS = 2
INTRO_UNITS = 1


def build_lesson(raw: dict, provider, limit_seconds: float | None = None,
                 model_label: str = "default", prompt_version: int = 1,
                 progress=None, workers: int | None = None, effort: str = "default",
                 provider_name: str = "claude-cli", model_id: str | None = None) -> tuple[dict, dict]:
    """Return ``(lesson, stats)``; stats has chunks, fallback_chunks, vocab_failed, intro_failed,
    usage (the provider's token totals) and costUsd (``None`` when ``model_id`` has no price).

    ``progress(phase, done, total)`` is called after each chunk ("segment"), when the vocabulary
    call starts ("vocab"), when the intro call starts ("intro") and at the end ("finish").

    Chunks are independent, so ``workers`` of them are segmented at once (default
    ``$YTLEARN_WORKERS`` or 4); cues come back in chunk order regardless of completion order.

    ``ProviderFatal`` (bad key, quota, ...) propagates: queued chunks are cancelled so no further
    call is sent, and the chunks already in flight are waited for (their usage is recorded)."""
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
    ref = raw.get("ref")  # optional official zh-Hant track: prompt reference only, never in the lesson

    stop = threading.Event()  # set by the first ProviderFatal: a worker freed by it must not start a new call

    def segment(chunk):
        if stop.is_set():
            return [], 0  # discarded: the build is already failing
        st = {"fallback_chunks": 0}
        try:
            return make_cues(words, chunk, provider, st, ref=ref), st["fallback_chunks"]
        except ProviderFatal:
            stop.set()
            raise

    results = []
    if workers <= 1:
        for chunk in chunks:
            results.append(segment(chunk))
            done += 1
            report("segment", done, total)
    else:
        pool = ThreadPoolExecutor(max_workers=min(workers, len(chunks)))
        try:
            futures = [pool.submit(segment, c) for c in chunks]
            for f in as_completed(futures):
                f.result()  # a ProviderFatal surfaces here as soon as its chunk fails
                done += 1
                report("segment", done, total)
            results = [f.result() for f in futures]  # chunk order
        finally:  # on an error, queued chunks are cancelled (a plain `with` would still run them all)
            pool.shutdown(wait=True, cancel_futures=True)
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
    usage = dict(getattr(provider, "usage", None) or cost.zero_usage())
    cost_usd = cost.cost_usd(model_id, usage) if model_id else None
    stats["usage"], stats["costUsd"] = usage, cost_usd
    lesson = {
        "videoId": raw["videoId"], "title": raw["title"], "channel": raw["channel"],
        "duration": duration, "lang": raw["lang"],
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "model": model_label, "effort": effort,
        # effortSent None means nothing was sent: the provider's own default
        "effortSent": getattr(provider, "effortSent", None) or effort,
        "provider": provider_name, "modelId": model_id, "usage": usage, "costUsd": cost_usd,
        "priceDate": cost.price_date(model_id) if model_id else None,
        "promptVersion": prompt_version, "coveredSeconds": covered,
        "words": [{k: v for k, v in w.items() if k != "ev"} for w in words],  # `ev` is internal
        "cues": cues, "vocab": vocab,
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


PROVIDERS = {"claude-cli": ClaudeCliProvider, "codex-cli": CodexCliProvider,
             "anthropic-api": AnthropicApiProvider, "openai-api": OpenAiApiProvider}
API_KEY_ENV = {"anthropic-api": "ANTHROPIC_API_KEY", "openai-api": "OPENAI_API_KEY"}


def canon_provider(name: str) -> str:
    """Map the old names ``claude``/``codex`` to ``claude-cli``/``codex-cli``; other names pass through."""
    return PROVIDER_ALIASES.get(name, name)


def _default_provider(model, cache_dir, provider="claude-cli", effort=None, api_key=None):
    name = canon_provider(provider)
    if name in API_KEY_ENV:  # API providers take the key first; main never passes model=None to them
        return PROVIDERS[name](api_key, model=model, cache_dir=cache_dir, effort=effort)
    return PROVIDERS[name](model=model, cache_dir=cache_dir, effort=effort)


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


def usage_writer(path: Path, model_id: str | None, provider: str | None = None):
    """Return a usage sink that atomically rewrites ``path`` with the running token totals, their
    USD estimate and the canonical ``provider`` (so an orphaned file is billed to the right bucket);
    write errors are ignored. The provider calls it under its usage lock."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")

    def write(u: dict):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps({
                "usage": dict(u), "costUsd": cost.cost_usd(model_id, u) if model_id else None,
                "modelId": model_id, "provider": provider, "pid": os.getpid(),
                "ts": datetime.now().astimezone().isoformat(timespec="seconds")}), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            tmp.unlink(missing_ok=True)
    return write


def main(argv=None, data_dir: Path | str = "data", provider_factory=_default_provider) -> int:
    ap = argparse.ArgumentParser(prog="python3 -m pipeline.build")
    ap.add_argument("video_id")
    ap.add_argument("--limit-seconds", type=float, default=None)
    ap.add_argument("--provider", choices=(*PROVIDERS, *PROVIDER_ALIASES),
                    default=os.environ.get("YTLEARN_PROVIDER") or "claude-cli",
                    help="who answers the prompts: a logged-in CLI or an API with your key "
                         "(env YTLEARN_PROVIDER); default claude-cli; claude/codex are old names for the CLIs")
    ap.add_argument("--model", default=None,
                    help=f"model name for the provider; claude-cli and anthropic-api default to $YTLEARN_MODEL "
                         f"or {DEFAULT_MODEL}, openai-api needs one (flag or $YTLEARN_MODEL), codex-cli uses its "
                         "own config (YTLEARN_MODEL is ignored for codex)")
    ap.add_argument("--effort", choices=("default", *EFFORTS), default=os.environ.get("YTLEARN_EFFORT") or None,
                    help="reasoning effort (env YTLEARN_EFFORT); default = the CLI's own; codex caps it at high")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--progress-file", default=os.environ.get("YTLEARN_PROGRESS_FILE") or None,
                    help="write {phase, done, total} JSON here as the build advances (env YTLEARN_PROGRESS_FILE)")
    ap.add_argument("--usage-file", default=os.environ.get("YTLEARN_USAGE_FILE") or None,
                    help="write {usage, costUsd, modelId, pid, ts} JSON here after each billed call "
                         "(env YTLEARN_USAGE_FILE)")
    args = ap.parse_args(argv)
    args.provider = canon_provider(args.provider)
    if args.provider not in PROVIDERS:  # argparse does not check an env-derived default against choices
        ap.error(f"unknown provider {args.provider!r} (YTLEARN_PROVIDER); choose one of {', '.join(PROVIDERS)}")
    if args.effort is not None and args.effort not in ("default", *EFFORTS):  # env default, unchecked by argparse
        ap.error(f"unknown effort {args.effort!r} (YTLEARN_EFFORT); choose one of default, {', '.join(EFFORTS)}")
    if args.effort == "default":
        args.effort = None
    api_key = None
    if args.provider in API_KEY_ENV:
        var = API_KEY_ENV[args.provider]
        api_key = (os.environ.get(var) or "").strip()
        if not api_key:
            print(f"error: 缺少 {var}（請在設定頁貼上 API key）", file=sys.stderr)
            return 1
    if args.model is None and args.provider in ("claude-cli", "anthropic-api"):
        args.model = os.environ.get("YTLEARN_MODEL") or DEFAULT_MODEL  # codex keeps its own config's model
    if args.model is None and args.provider == "openai-api":
        args.model = os.environ.get("YTLEARN_MODEL") or None
        if not args.model:  # never send "model": null
            print("error: openai-api 需要 --model 或 YTLEARN_MODEL", file=sys.stderr)
            return 1
    is_codex = args.provider == "codex-cli"
    effective_effort = (CODEX_EFFORT[args.effort] if is_codex else args.effort) if args.effort else None
    workers = _workers_from_env()
    model_label = (f"codex:{args.model or 'default'}" if is_codex
                   else f"openai:{args.model}" if args.provider == "openai-api" else args.model)
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
    # Old two-argument factories keep working: the provider name, effort and key are only passed when needed.
    extra = {"effort": args.effort} if args.effort else {}
    if api_key:
        extra["api_key"] = api_key
    provider = (provider_factory(args.model, data / "cache" / vid, args.provider, **extra) if args.provider != "claude-cli"
                else provider_factory(args.model, data / "cache" / vid, **extra))
    model_id = getattr(provider, "model", None) if is_codex else args.model  # bare name, for pricing
    if args.usage_file and hasattr(provider, "usage_sink"):
        provider.usage_sink = usage_writer(args.usage_file, model_id, args.provider)
    try:
        lesson, stats = build_lesson(raw, provider, args.limit_seconds, model_label=model_label,
                                     prompt_version=getattr(provider, "prompt_version", 1),
                                     progress=progress_writer(args.progress_file) if args.progress_file else None,
                                     workers=workers, effort=effective_effort or "default",
                                     provider_name=args.provider, model_id=model_id)
    except ProviderFatal as e:  # bad key, quota, retries exhausted: nothing was written
        print(f"error: {keys.scrub(str(e), [api_key])}", file=sys.stderr)
        return 3
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if stats["chunks"] and stats["fallback_chunks"] == stats["chunks"]:
        hint = "API key 與模型" if api_key else f"{args.provider} 已登入"
        print(f"所有切句呼叫都失敗（請確認 {hint}）；未寫入 lesson", file=sys.stderr)
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
    u, c = stats["usage"], stats["costUsd"]
    print(f"cues={len(lesson['cues'])} vocab={len(lesson['vocab'])} "
          f"fallback_chunks={stats['fallback_chunks']}/{stats['chunks']} "
          f"vocab_status={'skipped' if stats['vocab_failed'] else 'ok'} "
          f"intro={'failed' if stats['intro_failed'] else 'ok'} "
          f"llm_calls={getattr(provider, 'calls', 0)} cache_hits={getattr(provider, 'cache_hits', 0)} "
          f"seconds={time.monotonic() - t0:.1f} "
          f"usage=in:{u['input']}/cr:{u['cacheRead']}/cw:{u['cacheWrite']}/out:{u['output']} "
          f"cost_usd={'unknown' if c is None else format(c, '.6f')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
