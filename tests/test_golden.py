"""Byte-for-byte pins of what the LLM sees and what a lesson stores.

The hashes were recorded before `ev` was added to normalize_words and before the _spread_untimed
integer-millisecond fix (Netflix step 3). Words gained an internal `ev` key; neither the segment
prompt nor the lesson's `words` may change because of it. If one of these fails, a change leaked
into prompts or lessons: re-record only on purpose."""
import hashlib
import json
from pathlib import Path

from pipeline.build import build_lesson
from pipeline.chunk import chunk_words
from pipeline.segment import segment_user_prompt
from pipeline.words import normalize_words
from tests.test_build import fake_provider

FIX = Path(__file__).parent / "fixtures"

# Untimed runs over ordinary windows (wide enough that no millisecond push happens), timed words,
# a sound tag and a speaker marker: the paths whose output must not move.
UNTIMED_EVENTS = [
    {"t": 0, "d": 2400, "segs": [[None, "so this is where we start the walk"]]},
    {"t": 2400, "d": 1800, "segs": [[0, "and"], [300, "then"], [None, "we keep going north"]]},
    {"t": 4200, "d": 3000, "segs": [[None, ">> [Music] past the old mill"], [1900, "bridge"]]},
    {"t": 7200, "d": 900, "segs": [[None, "ok"]]},
]


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _prompts(words):
    return "\n\n".join(segment_user_prompt(words, a, b) for a, b in chunk_words(words))


def test_segment_prompts_are_unchanged():
    raw = json.loads((FIX / "raw_small.json").read_text("utf-8"))
    assert _sha(_prompts(normalize_words(raw["events"], raw["duration"]))) == RAW_SMALL_PROMPTS
    assert _sha(_prompts(normalize_words(UNTIMED_EVENTS, 9.0))) == UNTIMED_PROMPTS


def test_lesson_bytes_are_unchanged():
    raw = json.loads((FIX / "raw_small.json").read_text("utf-8"))
    lesson, _ = build_lesson(raw, fake_provider())
    lesson.pop("generatedAt")
    assert _sha(json.dumps(lesson, ensure_ascii=False, indent=1)) == RAW_SMALL_LESSON


def test_untimed_word_times_are_unchanged():
    words = normalize_words(UNTIMED_EVENTS, 9.0)
    plain = [{k: v for k, v in w.items() if k != "ev"} for w in words]
    assert _sha(json.dumps(plain, ensure_ascii=False, indent=1)) == UNTIMED_WORDS


RAW_SMALL_PROMPTS = "c15742cd5e68243d65046db6fc1d9d1aaaafb657668705f7844b5843147c6347"
UNTIMED_PROMPTS = "7db529a4cf577ec37f1e4b6d39658a9d982a41ee8a5eca4f570217de855f415c"
RAW_SMALL_LESSON = "bc9fb7694bbb68c149ec0ff4572205acd471d8a338ce06113d44518e34c09392"
UNTIMED_WORDS = "5c5278c2c518baeae51ab833b0446f58b9babd22441f944d5f2bc0966251caf7"
