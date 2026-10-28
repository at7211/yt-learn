import json
from pathlib import Path

from pipeline import schema
from pipeline.intro import INTRO_SCHEMA, INTRO_SYSTEM, intro_user_prompt, make_intro, validate_intro
from pipeline.llm import FakeProvider, ProviderError

GOOD = {"title": "2023 年 11 月 14 日\n參議院勞工委員會", "lines": ["參議員 Mullin 質詢", "工會會長 O'Brien 作證"]}
META = {"title": "Hearing", "channel": "CNBC", "duration": 98}
CUES = [{"a": i, "b": i, "en": f"sentence {i}", "tokens": [f"s{i}"], "zh": "句"} for i in range(50)]


def lesson_min():
    return json.loads((Path(__file__).parent / "fixtures" / "lesson_min.json").read_text(encoding="utf-8"))


def test_make_intro_returns_trimmed_card_and_uses_schema():
    prov = FakeProvider([{"title": " 主題 \n 第二行", "lines": [" 講者 A "]}])
    stats = {}
    assert make_intro(META, CUES, prov, stats) == {"title": "主題\n第二行", "lines": ["講者 A"]}
    assert "intro_failed" not in stats
    system, user, sch = prov.calls[0]
    assert system == INTRO_SYSTEM and sch is INTRO_SCHEMA
    assert "影片標題：Hearing" in user and "頻道：CNBC" in user and "長度：1:38" in user


def test_make_intro_invalid_shapes_fail_softly():
    bad = [
        {"title": "a\nb\nc", "lines": ["x"]},            # three title lines
        {"title": "一二三四五六七八九十一二三四五六七", "lines": ["x"]},  # 17 chars
        {"title": "ok", "lines": []},
        {"title": "ok", "lines": ["a", "b", "c"]},
        {"title": "ok", "lines": [" "]},
        {"title": "ok", "lines": ["a\nb"]},
        {"title": "ok\t", "lines": ["a"]},
        {"title": " \n第二行", "lines": ["a"]},
        {"title": "ok", "lines": "not a list"},
        "junk",
    ]
    for resp in bad:
        stats = {}
        assert make_intro(META, CUES, FakeProvider([resp]), stats) is None, resp
        assert stats == {"intro_failed": 1}, resp


def test_make_intro_provider_error_returns_none():
    stats = {}
    assert make_intro(META, CUES, FakeProvider([ProviderError("boom")]), stats) is None
    assert stats["intro_failed"] == 1


def test_user_prompt_limits_to_first_40_cues():
    user = intro_user_prompt("T", "C", 61, CUES)
    assert "全片共 50 句，以下是前 40 句" in user
    assert "#39: sentence 39" in user and "#40:" not in user
    assert "長度：1:01" in user


def test_validate_intro_messages():
    assert validate_intro(GOOD) == []
    assert validate_intro(None) == ["intro must be an object"]
    assert any("control" in e for e in validate_intro({"title": "a\rb", "lines": ["x"]}))


def test_validate_lesson_intro_optional_and_checked():
    les = lesson_min()
    assert schema.validate_lesson(les) == []
    les["intro"] = GOOD
    assert schema.validate_lesson(les) == []
    les["intro"] = None
    assert schema.validate_lesson(les) == ["intro: intro must be an object"]
    les["intro"] = {"title": "ok", "lines": "x"}
    assert any(e.startswith("intro: lines") for e in schema.validate_lesson(les))
