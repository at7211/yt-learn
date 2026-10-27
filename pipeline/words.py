"""Normalize raw caption events into a flat, timed word list."""
import html

_TIMED_CAP = 1.5
_LAST_WORD_SPAN = 1.0


def normalize_words(events: list[dict], duration: float) -> list[dict]:
    words = []
    for ev in events:
        ev_start = ev["t"] / 1000
        ev_end = (ev["t"] + ev["d"]) / 1000
        for offset, text in ev["segs"]:
            text = html.unescape(text)
            if offset is None:
                for token in text.split():
                    words.append({"t": ev_start, "w": token, "timed": False, "_ev_end": ev_end})
            elif text.strip():
                words.append({"t": (ev["t"] + offset) / 1000, "w": text.strip(), "timed": True})

    for i, word in enumerate(words):
        t = word["t"]
        if not word["timed"]:
            e = min(word.pop("_ev_end"), duration)
        else:
            nxt = next((w["t"] for w in words[i + 1:] if w["t"] > t), None)
            if nxt is None:
                e = min(t + _LAST_WORD_SPAN, duration)
            else:
                e = min(nxt, t + _TIMED_CAP)
        word["t"] = round(t, 3)
        word["e"] = round(max(e, t), 3)
    return words
