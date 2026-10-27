"""Normalize raw caption events into a flat, timed word list."""
import html

_TIMED_CAP = 1.5
_NO_SUCCESSOR_SPAN = 1.0


def normalize_words(events: list[dict], duration: float) -> list[dict]:
    """Flatten caption events into words ``{"t", "e", "w", "timed"}`` (seconds).

    Timed word: ``e`` is the ``t`` of the next word whose ``t`` is strictly
    greater than this word's ``t``, capped at ``t + 1.5``. A timed word with no
    later greater ``t`` (not only the last word overall) gets
    ``e = min(t + 1.0, duration)``.
    Untimed word: ``e = min(event end, duration)``, no cap.
    ``e`` is never less than ``t``.
    """
    words = []
    ev_ends = []  # parallel to words; used for untimed words
    for ev in events:
        ev_start = ev["t"] / 1000
        ev_end = (ev["t"] + ev["d"]) / 1000
        for offset, text in ev["segs"]:
            text = html.unescape(text)
            if offset is None:
                for token in text.split():
                    words.append({"t": ev_start, "w": token, "timed": False})
                    ev_ends.append(ev_end)
            elif text.strip():
                words.append({"t": (ev["t"] + offset) / 1000, "w": text.strip(), "timed": True})
                ev_ends.append(ev_end)

    # Next-strictly-greater t, one reverse pass with a monotonic stack (O(n)).
    successors = [None] * len(words)
    stack = []
    for i in range(len(words) - 1, -1, -1):
        t = words[i]["t"]
        while stack and stack[-1] <= t:
            stack.pop()
        successors[i] = stack[-1] if stack else None
        stack.append(t)

    for word, ev_end, nxt in zip(words, ev_ends, successors):
        t = word["t"]
        if not word["timed"]:
            e = min(ev_end, duration)
        elif nxt is None:
            e = min(t + _NO_SUCCESSOR_SPAN, duration)
        else:
            e = min(nxt, t + _TIMED_CAP)
        word["t"] = round(t, 3)
        word["e"] = round(max(e, t), 3)
    return words
