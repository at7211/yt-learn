"""Normalize raw caption events into a flat, timed word list."""
import html

_TIMED_CAP = 1.5
_NO_SUCCESSOR_SPAN = 1.0


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
    Untimed words (no per-word offsets) are spread across their caption event by
    cumulative character length (single spaces between words counted), so cues
    that start mid-event get distinct, increasing start times; they stay
    ``timed=False``. Each untimed word's ``e`` is the next untimed word's ``t``;
    the event's last word gets ``min(event end, duration)``. A zero-length event
    puts all its words at the event start.
    ``e`` is never less than ``t``.
    """
    words = []
    fixed_e = {}  # index -> end for untimed words (set when their event is flushed)
    for ev in events:
        ev_start = ev["t"] / 1000
        ev_end = (ev["t"] + ev["d"]) / 1000
        untimed = []  # indices of this event's untimed words
        for offset, text in ev["segs"]:
            text = html.unescape(text)
            if offset is None:
                for token in text.split():
                    untimed.append(len(words))
                    words.append({"t": ev_start, "w": token, "timed": False})
            elif text.strip():
                words.append({"t": (ev["t"] + offset) / 1000, "w": text.strip(), "timed": True})
        _spread_untimed(words, untimed, ev_start, ev_end, duration, fixed_e)

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
