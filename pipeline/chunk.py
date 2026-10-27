"""Split a normalized word list into batches (one LLM call each)."""

_EPS = 1e-9  # tolerate float error in start-time differences


def chunk_words(words, target=120, hard_max=160, gap=1.0, window=30):
    """Return inclusive, contiguous (a, b) index ranges covering all words.

    A cut point after i exists when words[i+1]["t"] - words[i]["t"] >= gap.
    From a, pick the cut point within [a+target-window, a+target+window]
    closest to a+target (ties -> earlier); with none, hard-cut at hard_max.
    With no cut point and fewer than hard_max words left, the tail is one batch.
    """
    n = len(words)
    ranges = []
    a = 0
    while a < n:
        goal = a + target
        lo = max(a, goal - window)
        hi = min(goal + window, n - 2)
        best = None
        for i in range(lo, hi + 1):
            if words[i + 1]["t"] - words[i]["t"] >= gap - _EPS:
                if best is None or abs(i - goal) < abs(best - goal):
                    best = i
        if best is not None:
            b = best
        elif a + hard_max - 1 >= n - 1:
            b = n - 1  # short final tail: one batch, no gap search
        else:
            b = a + hard_max - 1
        ranges.append((a, b))
        a = b + 1
    return ranges
