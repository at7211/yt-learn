"""The "前情提要" intro card: one LLM call per lesson, an optional ``intro`` field on the lesson.

Failure (provider error, invalid shape, over-long text) never fails the build: ``make_intro``
returns None and the lesson simply has no card.
"""
from __future__ import annotations

import re
import sys

from .llm import ProviderError

INTRO_PROMPT_VERSION = 3
TITLE_LINE_MAX = 16
TITLE_LINES_MAX = 2
LINE_MAX = 22
LINES_MAX = 2
PROMPT_CUES = 40

INTRO_SYSTEM = f"""[intro-prompt v{INTRO_PROMPT_VERSION}] 你是替英文影片寫「前情提要」小卡的編輯，讀者是台灣的英文學習者。使用者訊息會給影片標題、頻道、長度，以及開頭的字幕（格式「#編號: 英文句子」）。

請回傳 JSON：
- title：主標，寫這段影片的「場合或主題」。字幕或標題裡有明確的日期、事件才寫日期＋事件（例：第一行「2023 年 11 月 14 日」、第二行「參議院勞工委員會」）；否則寫主題（例：第一行「分散式交易」、第二行「兩階段提交與 Saga」）。最多 {TITLE_LINES_MAX} 行，行與行之間放一個換行字元（JSON 字串裡的 newline），每行最多 {TITLE_LINE_MAX} 個字。
- lines：1 到 {LINES_MAX} 行補充，寫人物與角色（例：「參議員 Mullin 質詢」「工會會長 O'Brien 作證」）或一句背景。每行最多 {LINE_MAX} 個字，不可換行。

規則：
- 只能使用字幕、標題、頻道名裡出現的事實。不得補上任何未出現的日期、地點、人名、職稱、數字。
- 不確定講者是誰就寫主題或頻道名（例：「Hello Interview 講解」），不要把頻道名當成講者本人，也不要猜測身分。
- 不劇透結論，不評價。不要出現「本影片」「這支影片」字樣。
- 繁體中文、台灣用語；人名與機構名可保留英文原文。
- 嚴格遵守字數上限，超過就改寫得更短。"""

INTRO_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "lines": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": LINES_MAX},
    },
    "required": ["title", "lines"],
}

_CONTROL = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")  # every C0 control except \n


def intro_user_prompt(title: str, channel: str, duration: float, cues: list[dict]) -> str:
    head = cues[:PROMPT_CUES]
    mins, secs = divmod(int(duration or 0), 60)
    out = [f"影片標題：{title}", f"頻道：{channel}", f"長度：{mins}:{secs:02d}", f"全片共 {len(cues)} 句，以下是前 {len(head)} 句："]
    out += [f"#{i}: {c.get('en', '')}" for i, c in enumerate(head)]
    return "\n".join(out)


def validate_intro(obj) -> list[str]:
    """Return error messages for an intro card; empty means valid."""
    if not isinstance(obj, dict):
        return ["intro must be an object"]
    errs = []
    title = obj.get("title")
    if not isinstance(title, str):
        errs.append("title must be a string")
    else:
        if _CONTROL.search(title):
            errs.append("title contains control characters")
        rows = title.split("\n")
        if len(rows) > TITLE_LINES_MAX:
            errs.append(f"title has more than {TITLE_LINES_MAX} lines")
        for r in rows:
            if not r.strip():
                errs.append("title has a blank line")
            elif len(r.strip()) > TITLE_LINE_MAX:
                errs.append(f"title line longer than {TITLE_LINE_MAX} chars")
    lines = obj.get("lines")
    if not isinstance(lines, list) or not 1 <= len(lines) <= LINES_MAX:
        errs.append(f"lines must be a list of 1-{LINES_MAX} strings")
    else:
        for ln in lines:
            if not isinstance(ln, str):
                errs.append("lines items must be strings")
            elif "\n" in ln or _CONTROL.search(ln):
                errs.append("lines items must be single lines")
            elif not ln.strip():
                errs.append("lines items must be non-empty")
            elif len(ln.strip()) > LINE_MAX:
                errs.append(f"lines item longer than {LINE_MAX} chars")
    return errs


def _warn(why: str) -> None:
    print(f"warning: intro card skipped ({why})", file=sys.stderr)


def _failed(stats: dict | None) -> None:
    if stats is not None:
        stats["intro_failed"] = stats.get("intro_failed", 0) + 1


RETRY_NOTE = "\n\n（上一次的回答超過字數或格式不符，被系統拒絕。請更精簡，嚴格遵守每行字數上限與行數。）"


def _ask(user: str, provider) -> tuple[dict | None, list[str]]:
    """One provider call: return (normalized response, errors)."""
    try:
        resp = provider.complete_json(INTRO_SYSTEM, user, INTRO_SCHEMA)
    except ProviderError as e:
        return None, ["provider: " + str(e)]
    if isinstance(resp, dict) and isinstance(resp.get("title"), str):
        # Models often write the line break as the two characters backslash + n; treat that as a newline.
        resp = dict(resp, title=resp["title"].replace("\\n", "\n"))
    return resp, validate_intro(resp)


def make_intro(meta: dict, cues: list[dict], provider, stats: dict | None = None) -> dict | None:
    """Return ``{"title", "lines"}`` (whitespace-trimmed) or None when anything goes wrong.

    A rejected reply is retried once with a note appended to the user message: the provider caches
    replies by prompt, so re-sending the identical prompt would only return the same bad answer.
    """
    user = intro_user_prompt(meta.get("title", ""), meta.get("channel", ""), meta.get("duration", 0), cues)
    resp, errs = _ask(user, provider)
    if errs and not errs[0].startswith("provider:"):
        resp, errs = _ask(user + RETRY_NOTE, provider)
    if errs:
        _warn("invalid LLM response: " + "; ".join(errs))
        _failed(stats)
        return None
    title = "\n".join(r.strip() for r in resp["title"].split("\n"))
    return {"title": title, "lines": [ln.strip() for ln in resp["lines"]]}
