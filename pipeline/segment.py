"""Sentence segmentation + translation of word chunks, with deterministic fallbacks."""
from __future__ import annotations

import sys

from pipeline.llm import ProviderError, ProviderFatal

SEGMENT_SYSTEM = """你是英文影片字幕的編輯與翻譯。輸入是一段沒有標點的自動產生英文逐字稿，第一行說明索引範圍，之後每行格式為「索引: 單字」。行首的索引是整部影片的全域索引（含頭含尾），不是這段內的 0 起算位置。

請把這段切成自然的句子或子句（cues），並翻譯成中文。規則：
1. 每個 cue 的 a 與 b 都是行首顯示的全域索引（含頭含尾）。cues 必須恰好涵蓋指定的索引範圍：第一個 cue 的 a 等於範圍起點，最後一個 cue 的 b 等於範圍終點，其間依序連續、不重疊、不遺漏（每個 cue 的 a 等於前一個 cue 的 b + 1）。絕對不可以跳號：輸出前請逐一檢查，每個相鄰 cue 都必須滿足「後一個的 a = 前一個的 b + 1」，範圍內每一個索引（包含只有一兩個字的短句）都要落在某個 cue 裡。
2. 每個 cue 最多 14 個單字；優先在句子結尾、子句邊界、語氣停頓處切開，不要在片語中間硬切。
3. tokens 是該 cue 的顯示版文字，對應索引 a 到 b 的每一個單字、依序排列，長度必須等於該 cue 的 b − a + 1。逐字處理：補上大小寫與標點（標點附在單字上，例如 "Hello," 或 "now."）；明顯的語音辨識錯字（人名、專有名詞）可依上下文修正，但每個詞仍對應原來那一個詞，絕對不可以合併、拆開、增加或刪除單字。
4. zh 是該 cue 的繁體中文（台灣用語）口語翻譯：簡短、自然、像人在說話，不要翻譯腔；語氣要跟隨逐字稿中說話者的語氣與場合。專有名詞用台灣慣用譯名，沒有慣用譯名就保留英文。
5. 只輸出符合 schema 的 JSON，不要任何說明文字。"""

SEGMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "cues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "a": {"type": "integer"},
                    "b": {"type": "integer"},
                    "tokens": {"type": "array", "items": {"type": "string"}},
                    "zh": {"type": "string"},
                },
                "required": ["a", "b", "tokens", "zh"],
            },
        }
    },
    "required": ["cues"],
}


# Appended to SEGMENT_SYSTEM only when the capture carries an official zh-Hant track (raw["ref"]).
SEGMENT_REF_ADDENDUM = """

這段另外附有參考資料：
6. 以「@」開頭的行（例如 @01:23.4，分:秒.十分之一秒）是時間標記，表示下面那幾個英文單字從這個時間開始；時間標記不是單字、沒有索引。
7. 最後「官方繁中字幕（參考）：」區塊是這部影片的官方繁體中文字幕，每行格式為「開始時間–結束時間 字幕文字」，只供翻譯用詞參考。參考行不屬於索引範圍，不可以當成單字計算，也不可以出現在 tokens 裡。
8. 英文語意優先：用時間標記找出時間重疊的參考句，語意相符就沿用它的用詞與譯名；不符（例如時間對不上、內容不同）就依英文自己翻。不得把英文沒說的內容寫進 zh。"""

REF_HEADING = "官方繁中字幕（參考）："


def _ms(seconds: float) -> int:
    return round(seconds * 1000)


def _clock(ms: int) -> str:
    """``mm:ss.d`` from integer ms, tenths floored; minutes are not capped at 59."""
    tenths = ms // 100
    return f"{tenths // 600:02d}:{tenths // 10 % 60:02d}.{tenths % 10}"


def segment_user_prompt(words: list[dict], a: int, b: int, *, ref: dict | None = None) -> str:
    """User prompt for words a..b (global, inclusive).

    ``ref`` is the raw capture's ``raw["ref"]`` dict ({"lang","kind","events":[{"t","d","text"}]},
    ms). Without it the prompt is exactly the classic index list. With it, an ``@mm:ss.d`` time
    marker precedes the first word and every word whose source event (``ev``; missing = same as the
    previous word) changes, and the ref events overlapping the chunk's half-open time range
    [words[a].t, words[b].e) are appended under REF_HEADING; with no overlap the block is omitted."""
    lines = [f"索引範圍 {a}..{b}，共 {b - a + 1} 個單字："]
    if ref is None:
        lines += [f"{i}: {words[i]['w']}" for i in range(a, b + 1)]
        return "\n".join(lines)
    prev_ev = None
    for i in range(a, b + 1):
        ev = words[i].get("ev")
        ev = prev_ev if ev is None else ev  # missing/None = same event as the previous word
        if i == a or ev != prev_ev:
            lines.append(f"@{_clock(_ms(words[i]['t']))}")
        prev_ev = ev
        lines.append(f"{i}: {words[i]['w']}")
    start, end = _ms(words[a]["t"]), _ms(words[b]["e"])
    hits = sorted((e for e in ref["events"] if e["t"] < end and e["t"] + e["d"] > start),
                  key=lambda e: e["t"])
    if hits:
        lines += ["", REF_HEADING]
        # One line per reference event: whitespace (incl. newlines in hand-imported raws) collapsed so a
        # reference line can never look like a word line or a time marker.
        lines += [f"{_clock(e['t'])}\u2013{_clock(e['t'] + e['d'])} {' '.join(e['text'].split())}" for e in hits]
    return "\n".join(lines)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_cues(resp: dict, a: int, b: int) -> list[dict] | None:
    """Return cleaned cues sorted by `a`, or None if the batch must be rejected.

    Token-count mismatches are NOT repaired here (no access to words); make_cues
    swaps in raw words for those cues.
    """
    cues = resp.get("cues") if isinstance(resp, dict) else None
    if not isinstance(cues, list) or not cues:
        return None
    out = []
    for c in cues:
        if not isinstance(c, dict):
            return None
        ca, cb, tokens, zh = c.get("a"), c.get("b"), c.get("tokens"), c.get("zh")
        if not (_is_int(ca) and _is_int(cb) and isinstance(tokens, list)
                and all(isinstance(t, str) for t in tokens) and isinstance(zh, str)):
            return None
        if not (a <= ca <= cb <= b):
            return None
        out.append({"a": ca, "b": cb, "tokens": list(tokens), "zh": zh})
    out.sort(key=lambda c: c["a"])
    if out[0]["a"] != a or out[-1]["b"] != b:
        return None
    for prev, nxt in zip(out, out[1:]):
        if nxt["a"] != prev["b"] + 1:
            return None
    return out


def rule_cues(words: list[dict], a: int, b: int, max_words: int = 14) -> list[dict]:
    cues, start = [], a
    for i in range(a, b + 1):
        end = i == b or (i - start + 1) >= max_words or words[i + 1]["t"] - words[i]["t"] >= 1.0
        if end:
            cues.append({"a": start, "b": i, "tokens": [words[j]["w"] for j in range(start, i + 1)], "zh": ""})
            start = i + 1
    return cues


def _warn(a: int, b: int, why: str) -> None:
    print(f"warning: segmentation of words {a}..{b} fell back to rule cues ({why})", file=sys.stderr)


def make_cues(words: list[dict], chunk: tuple[int, int], provider,
              stats: dict | None = None, *, ref: dict | None = None) -> list[dict]:
    """Segment one chunk; on whole-chunk fallback, increments ``stats["fallback_chunks"]``.

    ``ref`` (raw["ref"], optional) adds time markers + reference lines to the user prompt and
    SEGMENT_REF_ADDENDUM to the system prompt; with ref=None the call is unchanged."""
    a, b = chunk

    def fell_back():
        if stats is not None:
            stats["fallback_chunks"] = stats.get("fallback_chunks", 0) + 1

    user = segment_user_prompt(words, a, b, ref=ref)
    system = SEGMENT_SYSTEM if ref is None else SEGMENT_SYSTEM + SEGMENT_REF_ADDENDUM
    try:
        resp = provider.complete_json(system, user, SEGMENT_SCHEMA)
    except ProviderFatal:
        raise  # bad key / quota / retries exhausted: stop the build, do not degrade
    except ProviderError as e:
        _warn(a, b, str(e))
        fell_back()
        return rule_cues(words, a, b)
    cues = validate_cues(resp, a, b)
    if cues is None:
        _warn(a, b, "invalid LLM response")
        fell_back()
        return rule_cues(words, a, b)
    for c in cues:
        if len(c["tokens"]) != c["b"] - c["a"] + 1 or any(
                not t.strip() or len(t.split()) != 1 for t in c["tokens"]):
            c["tokens"] = [words[i]["w"] for i in range(c["a"], c["b"] + 1)]
    return cues


def finalize_cues(cues: list[dict], words: list[dict]) -> list[dict]:
    out = sorted((dict(c) for c in cues), key=lambda c: c["a"])
    expect = 0
    for c in out:
        if c["a"] != expect or c["b"] < c["a"]:
            raise ValueError(f"cues not contiguous at word {expect} (cue starts at {c['a']})")
        expect = c["b"] + 1
    if expect != len(words):
        raise ValueError(f"cues cover {expect} of {len(words)} words")
    for c in out:
        c["en"] = " ".join(c["tokens"])
    return out
