"""Vocabulary selection: the LLM names terms + cue numbers; code locates exact spans."""
from __future__ import annotations

import re
import sys

from pipeline.llm import ProviderError

POS_ENUM = ["n.", "v.", "adj.", "adv.", "phr.", "idiom"]

VOCAB_SYSTEM = """你是替英文影片製作學習單字表的英文老師，學生是中高級程度的台灣英文學習者。使用者訊息會列出編號的字幕（格式「#編號: 英文句子」），以及全片單字總數與目標項目數。

請從字幕中挑出值得學的單字與多字詞（片語、慣用語、搭配詞）。規則：
1. 以「在這部影片的上下文中」的用法為準，挑選對中高級學習者有學習價值的表達；優先選生動、不容易從字面猜出意思的用法（慣用語、俚語、動詞片語、搭配詞）。
2. 避免太簡單的功能詞（the、is、and 之類）與人名、地名等專有名詞。項目數量盡量接近目標項目數，寧缺勿濫，不要重複。不要選過於簡單、中高級學習者早就會的詞（例如 sit down、respond、pretend 這類基本字），也不要只選半截片語：多字詞必須是完整、可獨立理解的表達（選 tough guy act 或 quit the tough guy act，不要只選 quit the）。
3. term 必須是該詞在字幕文字中出現的「原樣」：相同的詞形變化、相同的單字、相同的順序（可以省略前後的標點），不可改成原形、不可換字、不可重組，程式要靠它在字幕中找到位置。例如字幕是 "exposed" 就寫 exposed，不要寫 expose。
4. pos 只能是 n.、v.、adj.、adv.、phr.、idiom 其中之一（多字詞用 phr. 或 idiom）。
5. ipa 只給單一單字（例如 "/ɪkˈspoʊzd/"）；多字詞一律給 null。
6. zh 是符合此處語境的簡短繁體中文（台灣用語）解釋，不超過 12 個字；必要時可加註，例如（粗口）、（俚語）。
7. cues 是該詞出現的字幕編號（整數陣列），只列確實含有該 term 的編號。
8. 只輸出符合 schema 的 JSON，不要任何說明文字。"""

VOCAB_SCHEMA = {
    "type": "object",
    "properties": {
        "vocab": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "term": {"type": "string"},
                    "pos": {"type": "string", "enum": POS_ENUM},
                    "ipa": {"type": ["string", "null"]},
                    "zh": {"type": "string"},
                    "cues": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["term", "pos", "ipa", "zh", "cues"],
            },
        }
    },
    "required": ["vocab"],
}


def vocab_user_prompt(cues: list[dict], words: list[dict], target: int) -> str:
    lines = [f"全片共 {len(words)} 個單字，共 {len(cues)} 句字幕，目標 {target} 個項目。字幕如下："]
    lines += [f"#{i}: {c['en']}" for i, c in enumerate(cues)]
    return "\n".join(lines)


_EDGE = re.compile(r"^[\W_]+|[\W_]+$")


def _norm_tokens(s: str) -> list[str]:
    return [_EDGE.sub("", t).lower() for t in s.split()]


def norm(s: str) -> str:
    return " ".join(t for t in _norm_tokens(s) if t)


def _norm_slot(tok: str) -> str | None:
    """Normalize ONE token. Empty or whitespace-containing results can never match (None)."""
    n = _EDGE.sub("", tok.strip()).lower()
    return n if n and not any(ch.isspace() for ch in n) else None


def find_spans(term: str, cue: dict, words: list[dict]) -> list[tuple[int, int]]:
    seq = norm(term).split()
    n = len(seq)
    if n == 0:
        return []
    a, b = cue["a"], cue["b"]
    toks = [_norm_slot(t) for t in cue["tokens"][: b - a + 1]]
    raw = [_norm_slot(words[i]["w"]) for i in range(a, b + 1)]
    spans = set()
    for seen in (toks, raw):
        for k in range(min(len(seen), b - a + 1) - n + 1):
            if seen[k:k + n] == seq:
                spans.add((a + k, a + k + n - 1))
    return sorted(spans)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_hits(vocab_raw: list, cues: list[dict], words: list[dict]) -> list[dict]:
    out = []
    if not isinstance(vocab_raw, list):
        return out
    for it in vocab_raw:
        if not isinstance(it, dict):
            continue
        term, pos, zh, cue_ids = it.get("term"), it.get("pos"), it.get("zh"), it.get("cues")
        if not (isinstance(term, str) and term.strip() and pos in POS_ENUM and isinstance(zh, str)
                and isinstance(cue_ids, list) and all(_is_int(c) for c in cue_ids)):
            continue
        found, seen = [], set()
        for ci in cue_ids:
            if not 0 <= ci < len(cues):
                continue
            for a, b in find_spans(term, cues[ci], words):
                if (ci, a, b) not in seen:
                    seen.add((ci, a, b))
                    found.append({"cue": ci, "a": a, "b": b})
        if not found:
            continue
        ipa = it.get("ipa")
        if not (isinstance(ipa, str) and ipa.strip()) or " " in term.strip():
            ipa = None
        out.append({"term": term, "pos": pos, "ipa": ipa, "zh": zh, "hits": found})
    return out


def expand_hits(vocab: list[dict], cues: list[dict], words: list[dict]) -> list[dict]:
    out = []
    for it in vocab:
        hits = list(it["hits"])
        seen = {(h["cue"], h["a"], h["b"]) for h in hits}
        for ci, cue in enumerate(cues):
            for a, b in find_spans(it["term"], cue, words):
                if (ci, a, b) not in seen:
                    seen.add((ci, a, b))
                    hits.append({"cue": ci, "a": a, "b": b})
        hits.sort(key=lambda h: (words[h["a"]]["t"], h["a"], h["b"]))
        out.append({**it, "hits": hits})
    return out


def _warn(why: str) -> None:
    print(f"warning: vocabulary selection skipped ({why})", file=sys.stderr)


def _failed(stats: dict | None) -> None:
    if stats is not None:
        stats["vocab_failed"] = stats.get("vocab_failed", 0) + 1


def pick_vocab(cues: list[dict], words: list[dict], provider, max_items: int = 120,
               stats: dict | None = None) -> list[dict]:
    target = min(max(5, round(len(words) / 10)), max_items)
    try:
        resp = provider.complete_json(VOCAB_SYSTEM, vocab_user_prompt(cues, words, target), VOCAB_SCHEMA)
    except ProviderError as e:
        _warn(str(e))
        _failed(stats)
        return []
    raw = resp.get("vocab") if isinstance(resp, dict) else None
    if not isinstance(raw, list):
        _warn("invalid LLM response")
        _failed(stats)
        return []
    items = expand_hits(validate_hits(raw, cues, words), cues, words)
    merged: dict[str, dict] = {}
    for it in items:
        key = norm(it["term"])
        if key in merged:
            have = {(h["cue"], h["a"], h["b"]) for h in merged[key]["hits"]}
            merged[key]["hits"] += [h for h in it["hits"] if (h["cue"], h["a"], h["b"]) not in have]
        else:
            merged[key] = it
    out = list(merged.values())
    for it in out:
        it["hits"].sort(key=lambda h: (words[h["a"]]["t"], h["a"], h["b"]))
    out.sort(key=lambda it: words[it["hits"][0]["a"]]["t"])
    out = out[:max_items]
    return [{"id": i, **it} for i, it in enumerate(out)]
