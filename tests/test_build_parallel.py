"""Chunk segmentation runs ``workers`` chunks at once and keeps cues in chunk order."""
import json
import threading
import time
from pathlib import Path

from pipeline.build import build_lesson
from pipeline.chunk import chunk_words
from pipeline.words import normalize_words

FIX = Path(__file__).parent / "fixtures"


class JitterProvider:
    """Answers any segment prompt for the chunk it names (parsed from the prompt), with a delay that
    makes later chunks finish first; records how many calls overlapped."""

    def __init__(self, words):
        self.words = words
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.chunks = list(chunk_words(words))

    def complete_json(self, system, user, schema=None):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            # identify the chunk by the words the prompt quotes (segment prompts list the chunk's words)
            found = None
            for a, b in self.chunks:
                if self.words[a]["w"] in user and self.words[b]["w"] in user and all(
                        self.words[i]["w"] in user for i in range(a, b + 1, max(1, (b - a) // 5))):
                    found = (a, b)
                    break
            if found is None:
                return {"vocab": []} if "vocab" in system.lower() or "單字" in system else {"title": "x", "lines": []}
            a, b = found
            time.sleep(0.05 if a > 0 else 0.15)  # the first chunk finishes last
            return {"cues": [{"a": a, "b": b, "tokens": [self.words[i]["w"] for i in range(a, b + 1)], "zh": "譯"}]}
        finally:
            with self.lock:
                self.active -= 1


def test_parallel_segmentation_keeps_chunk_order_and_overlaps():
    raw = json.loads((FIX / "raw_small.json").read_text(encoding="utf-8"))
    words = normalize_words(raw["events"], raw["duration"])
    prov = JitterProvider(words)
    calls = []
    lesson, stats = build_lesson(raw, prov, workers=4, progress=lambda ph, d, t: calls.append((ph, d)))
    starts = [c["a"] for c in lesson["cues"]]
    assert starts == sorted(starts), "cues must come back in chunk order"
    assert stats["chunks"] == len(prov.chunks) and stats["fallback_chunks"] == 0
    assert prov.max_active >= 2, "chunks should be segmented concurrently"
    seg = [d for ph, d in calls if ph == "segment"]
    assert seg == sorted(seg) and seg[-1] == len(prov.chunks)
