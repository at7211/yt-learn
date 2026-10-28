"""Normalize raw caption events into a flat, timed word list."""
import html
import re

_TIMED_CAP = 1.5
_NO_SUCCESSOR_SPAN = 1.0
_SPEAKER_MARKER = re.compile(r">+")  # YouTube ASR writes ">>" at speaker changes; it is not a word


def _spread_untimed(words, idx, ev_start, ev_end, duration, fixed_e):
    if not idx:
        return
    span = ev_end - ev_start
    total = sum(len(words[i]["w"]) for i in idx) + len(idx) - 1
    before = 0
    starts = []
    for i in idx:
        starts.append(round(ev_start + span * before / total, 3))
        before += len(words[i]["w"]) + 1
    for k in range(1, len(starts)):
        if span > 0 and starts[k] <= starts[k - 1]:
            starts[k] = round(starts[k - 1] + 0.001, 3)
    last_end = min(ev_end, duration)
    for k, i in enumerate(idx):
        words[i]["t"] = starts[k]
        fixed_e[i] = starts[k + 1] if k + 1 < len(idx) else last_end


def normalize_words(events: list[dict], duration: float) -> list[dict]:
    """Flatten caption events into words ``{"t", "e", "w", "timed"}`` (seconds).

    Timed word: ``e`` is the ``t`` of the next word whose ``t`` is strictly
    greater than this word's ``t``, capped at ``t + 1.5``. A timed word with no
    later greater ``t`` (not only the last word overall) gets
    ``e = min(t + 1.0, duration)``.
    Untimed words (no per-word offsets) are spread by cumulative character length
    (single spaces between words counted) across the window between their timed
    neighbours inside the event: from the event start (or just after the previous
    timed word) to the next timed word's ``t`` (or the event end). So cues that
    start mid-event get distinct, increasing start times and a leading untimed
    run never overtakes the timed words that follow it; they stay ``timed=False``.
    Each untimed word's ``e`` is the next untimed word's ``t``; the run's last word
    gets ``min(window end, duration)``. A zero-length window puts all its words at
    the window start. ``>>`` speaker-change markers are dropped.
    ``e`` is never less than ``t``.
    """
    words = []
    fixed_e = {}  # index -> end for untimed words (set when their event is flushed)
    for ev in events:
        ev_start = ev["t"] / 1000
        ev_end = (ev["t"] + ev["d"]) / 1000
        toks = []  # (t or None, token) for this event, in order
        for offset, text in ev["segs"]:
            text = html.unescape(text)
            if offset is None:
                toks += [(None, tok) for tok in text.split() if not _SPEAKER_MARKER.fullmatch(tok)]
            elif text.strip() and not _SPEAKER_MARKER.fullmatch(text.strip()):
                toks.append(((ev["t"] + offset) / 1000, text.strip()))
        base = len(words)
        for t, tok in toks:
            words.append({"t": ev_start if t is None else t, "w": tok, "timed": t is not None})
        i = 0
        while i < len(toks):
            if toks[i][0] is not None:
                i += 1
                continue
            j = i
            while j < len(toks) and toks[j][0] is None:
                j += 1
            lo = ev_start if i == 0 else min(ev_end, toks[i - 1][0] + 0.001)
            hi = ev_end if j == len(toks) else max(lo, toks[j][0])
            _spread_untimed(words, list(range(base + i, base + j)), lo, hi, duration, fixed_e)
            i = j

    # Next-strictly-greater t, one reverse pass with a monotonic stack (O(n)).
    successors = [None] * len(words)
    stack = []
    for i in range(len(words) - 1, -1, -1):
        t = words[i]["t"]
        while stack and stack[-1] <= t:
            stack.pop()
        successors[i] = stack[-1] if stack else None
        stack.append(t)

    for i, (word, nxt) in enumerate(zip(words, successors)):
        t = word["t"]
        if not word["timed"]:
            e = fixed_e[i]
        elif nxt is None:
            e = min(t + _NO_SUCCESSOR_SPAN, duration)
        else:
            e = min(nxt, t + _TIMED_CAP)
        word["t"] = round(t, 3)
        word["e"] = round(max(e, t), 3)
    return words
