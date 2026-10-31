import copy

from pipeline import schema

GOOD = {
    "videoId": "puh91fohvTA", "title": "T", "channel": "dotconferences", "duration": 1378,
    "lang": "en", "kind": "asr", "capturedAt": "2026-10-27T23:00:00+08:00", "chrome": "142.0.7444.60",
    "events": [
        {"t": 10800, "d": 2840, "segs": [[0, "Bonjour"], [920, "and"], [1280, "hello."]]},
        {"t": 13640, "d": 2100, "segs": [[None, "And wouldn't it"]]},
    ],
}


def mod(**kw):
    o = copy.deepcopy(GOOD)
    o.update(kw)
    return o


def test_valid_raw_ok():
    assert schema.validate_raw(GOOD) == []


def test_optional_fields_may_be_absent():
    o = copy.deepcopy(GOOD)
    del o["capturedAt"], o["chrome"]
    assert schema.validate_raw(o) == []


def test_rejects_bad_video_id():
    assert schema.validate_raw(mod(videoId="../x"))
    assert schema.validate_raw(mod(videoId="abcdefghij"))  # length 10


def test_rejects_unsorted_events():
    evs = [{"t": 500, "d": 1, "segs": [[0, "a"]]}, {"t": 100, "d": 1, "segs": [[0, "b"]]}]
    assert schema.validate_raw(mod(events=evs))


def test_rejects_bad_seg_shape():
    assert schema.validate_raw(mod(events=[{"t": 0, "d": 1, "segs": [["x"]]}]))
    assert schema.validate_raw(mod(events=[{"t": 0, "d": 1, "segs": [[0, ""]]}]))


def test_rejects_empty_events_and_bad_numbers():
    assert schema.validate_raw(mod(events=[]))
    assert schema.validate_raw(mod(events=[{"t": -1, "d": 1, "segs": [[0, "a"]]}]))
    assert schema.validate_raw(mod(events=[{"t": 0, "d": -1, "segs": [[0, "a"]]}]))


def test_rejects_missing_meta():
    for k in ("title", "channel", "duration", "lang", "kind"):
        o = copy.deepcopy(GOOD)
        del o[k]
        assert schema.validate_raw(o), k


def test_rejects_non_object():
    assert schema.validate_raw([]) 


def test_rejects_non_numeric_duration():
    for bad in ("1378", True, -1, [1], {"a": 1}):
        assert schema.validate_raw(mod(duration=bad)), bad
    assert schema.validate_raw(mod(duration=1378.5)) == []


def _lesson():
    import json
    from pathlib import Path
    return json.loads((Path(__file__).parent / "fixtures" / "lesson_min.json").read_text(encoding="utf-8"))


def test_lesson_rejects_non_monotonic_words():
    les = _lesson()
    assert schema.validate_lesson(les) == []
    les["words"][1]["t"] = les["words"][0]["t"] - 0.1
    les["words"][1]["e"] = les["words"][1]["t"] + 0.1
    assert any("earlier" in e for e in schema.validate_lesson(les))


def test_lesson_rejects_non_increasing_cue_starts():
    les = _lesson()
    c = les["cues"][0]
    k = 2  # split the first fixture cue after word 1
    c2 = {**c, "a": k, "tokens": c["tokens"][k:], "en": " ".join(c["tokens"][k:])}
    c1 = {**c, "b": k - 1, "tokens": c["tokens"][:k], "en": " ".join(c["tokens"][:k])}
    les["cues"] = [c1, c2] + les["cues"][1:]
    les["vocab"] = []
    assert schema.validate_lesson(les) == []
    les["words"][k]["t"] = les["words"][0]["t"]
    les["words"][k]["e"] = max(les["words"][k]["e"], les["words"][k]["t"])
    assert any("cue" in e and "later" in e for e in schema.validate_lesson(les))


UDEMY_URL = "https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738"
UDEMY = {"videoId": "udemy.5800738", "source": "udemy", "sourceUrl": UDEMY_URL}


def test_raw_accepts_udemy_id_with_and_without_source_fields():
    assert schema.validate_raw(mod(**UDEMY)) == []
    assert schema.validate_raw(mod(**dict(UDEMY, sourceUrl=UDEMY_URL + "/?start=0#overview"))) == []
    assert schema.validate_raw(mod(videoId="udemy.5800738")) == []
    assert schema.validate_raw(mod(source="youtube")) == []
    assert schema.validate_raw(mod(videoId="udemy-12345")) == []  # 11 chars: a YouTube id


def test_raw_rejects_bad_udemy_ids():
    for bad in ("udemy.abc", "udemy.", "udemy.1234567890123", "Udemy.1", "udemy.1/../x"):
        assert schema.validate_raw(mod(videoId=bad)), bad


def test_source_must_match_id():
    assert schema.validate_raw(mod(source="udemy"))  # YouTube id
    assert schema.validate_raw(mod(videoId="udemy.5800738", source="youtube"))
    for bad in ("", None, "coursera", "UDEMY"):
        assert schema.validate_raw(mod(videoId="udemy.5800738", source=bad)), bad
    assert schema.validate_raw(mod(videoId="udemy-12345", source="udemy"))


def test_source_url_rejections():
    for bad in (
        "http://www.udemy.com/course/30-days-of-python/learn/lecture/5800738",
        "https://mycompany.udemy.com/course/30-days-of-python/learn/lecture/5800738",
        "https://www.udemy.com/course/30-days-of-python/learn/lecture/5800739",  # other lecture
        "https://www.udemy.com/course/30-days-of-python/",
        "javascript:alert(1)",
        "https://evil.com/",
        "", None, 42,
    ):
        assert schema.validate_raw(mod(**dict(UDEMY, sourceUrl=bad))), bad
    # YouTube ids carry no sourceUrl at all (not even their own watch URL).
    assert schema.validate_raw(mod(sourceUrl="https://www.youtube.com/watch?v=puh91fohvTA"))
    assert schema.validate_raw(mod(sourceUrl=UDEMY_URL))


def test_lesson_source_fields():
    les = _lesson()
    les.update(UDEMY)
    assert schema.validate_lesson(les) == []
    les2 = _lesson()
    les2["videoId"] = "udemy.5800738"
    assert schema.validate_lesson(les2) == []  # source fields optional
    assert schema.validate_lesson(dict(les, source="youtube"))
    assert schema.validate_lesson(dict(les, sourceUrl=UDEMY_URL.replace("5800738", "1")))
    assert schema.validate_lesson(dict(_lesson(), sourceUrl=UDEMY_URL))
    assert schema.validate_lesson(dict(les, videoId="udemy.x"))
