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
    assert schema.validate_raw(mod(source="hellointerview"))  # YouTube id
    assert schema.validate_raw(mod(videoId="hello.a.b", source="udemy"))
    assert schema.validate_raw(mod(videoId="udemy.5800738", source="hellointerview"))
    for bad in ("", None, "hello", "HelloInterview", "youtube"):
        assert schema.validate_raw(mod(videoId="hello.a.b", source=bad)), bad


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


NETFLIX_URL = "https://www.netflix.com/watch/81234567"
NETFLIX = {"videoId": "netflix.81234567", "source": "netflix", "sourceUrl": NETFLIX_URL}


def test_raw_accepts_netflix_id_with_and_without_source_fields():
    assert schema.validate_raw(mod(**NETFLIX)) == []
    assert schema.validate_raw(mod(videoId="netflix.81234567")) == []
    assert schema.validate_raw(mod(videoId="netflix.81234567", source="netflix")) == []


def test_raw_rejects_bad_netflix_ids_and_sources():
    for bad in ("netflix.abc", "netflix.", "netflix.1234567890123", "Netflix.1", "netflix.1/../x"):
        assert schema.validate_raw(mod(videoId=bad)), bad
    assert schema.validate_raw(mod(source="netflix"))  # YouTube id
    assert schema.validate_raw(mod(videoId="udemy.5800738", source="netflix"))
    for bad in ("udemy", "youtube", "NETFLIX", "", None):
        assert schema.validate_raw(mod(videoId="netflix.81234567", source=bad)), bad


def test_netflix_source_url_must_be_the_canonical_watch_url():
    for bad in (
        NETFLIX_URL + "?trackId=1",  # a real watch URL, but not the canonical one
        NETFLIX_URL + "/",
        "https://www.netflix.com/watch/81234568",  # other title
        "http://www.netflix.com/watch/81234567",
        "https://netflix.com/watch/81234567",
        "https://www.netflix.com/title/81234567",
        UDEMY_URL, "javascript:alert(1)", "", None, 42,
    ):
        assert schema.validate_raw(mod(**dict(NETFLIX, sourceUrl=bad))), bad
    assert schema.validate_raw(mod(sourceUrl=NETFLIX_URL))  # YouTube id
    assert schema.validate_raw(mod(**dict(UDEMY, sourceUrl=NETFLIX_URL)))


def test_lesson_netflix_source_fields():
    les = dict(_lesson(), **NETFLIX)
    assert schema.validate_lesson(les) == []
    assert schema.validate_lesson(dict(les, source="udemy"))
    assert schema.validate_lesson(dict(les, sourceUrl=NETFLIX_URL + "?x=1"))


HELLO_URL = "https://www.hellointerview.com/learn/system-design/patterns/dealing-with-contention"
HELLO = {"videoId": "hello.system-design.patterns.dealing-with-contention", "source": "hellointerview",
         "sourceUrl": HELLO_URL}


def test_raw_accepts_hello_id_with_and_without_source_fields():
    assert schema.validate_raw(mod(**HELLO)) == []
    assert schema.validate_raw(mod(videoId=HELLO["videoId"])) == []
    assert schema.validate_raw(mod(videoId=HELLO["videoId"], source="hellointerview")) == []
    assert schema.validate_raw(mod(videoId="hello.a.b.c.d.e.f")) == []
    assert schema.validate_raw(mod(videoId="hello." + "a" * 120)) == []
    assert schema.validate_lesson(dict(_lesson(), **HELLO)) == []


def test_raw_rejects_bad_hello_ids():
    for bad in ("hello.", "Hello.x", "hello.A", "hello.a..b", "hello.a_b", "hello.a.b.c.d.e.f.g",
                "hello." + "a" * 121, "hello.a/../b", "hello.a/b", "hello..a", "hello.a."):
        assert schema.validate_raw(mod(videoId=bad)), bad


def test_hello_source_url_must_be_canonical():
    for bad in (
        HELLO_URL + "?x=1",
        HELLO_URL + "#y",
        HELLO_URL + "/",
        HELLO_URL.replace("contention", "contention-2"),  # other path
        "https://www.hellointerview.com/learn/system-design",
        HELLO_URL.replace("https://", "http://"),
        HELLO_URL.replace("www.", ""),
        HELLO_URL.replace(".com/", ".com:443/"),
        UDEMY_URL, NETFLIX_URL, "javascript:alert(1)", "", None, 42,
    ):
        assert schema.validate_raw(mod(**dict(HELLO, sourceUrl=bad))), bad
        assert schema.validate_lesson(dict(_lesson(), **dict(HELLO, sourceUrl=bad))), bad
    assert schema.validate_raw(mod(sourceUrl=HELLO_URL))  # YouTube id
    assert schema.validate_raw(mod(**dict(NETFLIX, sourceUrl=HELLO_URL)))
    assert schema.validate_raw(mod(**dict(UDEMY, sourceUrl=HELLO_URL)))


COURSERA_URL = "https://www.coursera.org/learn/machine-learning/lecture/iYR2y/supervised-learning"
COURSERA = {"videoId": "coursera.machine-learning.iYR2y", "source": "coursera", "sourceUrl": COURSERA_URL}


def test_raw_accepts_coursera_id_with_and_without_source_fields():
    assert schema.validate_raw(mod(**COURSERA)) == []
    assert schema.validate_raw(mod(**dict(COURSERA, sourceUrl="https://www.coursera.org/learn/machine-learning/lecture/iYR2y"))) == []
    assert schema.validate_raw(mod(videoId="coursera.machine-learning.iYR2y")) == []


def test_raw_rejects_bad_coursera_ids_and_sources():
    for bad in ("coursera.abc", "coursera.", "coursera..x", "Coursera.a.b", "coursera.a.b.c", "coursera.a/../b.c"):
        assert schema.validate_raw(mod(videoId=bad)), bad
    assert schema.validate_raw(mod(source="coursera"))  # YouTube id
    assert schema.validate_raw(mod(videoId="udemy.5800738", source="coursera"))
    for bad in ("udemy", "youtube", "COURSERA", "", None):
        assert schema.validate_raw(mod(videoId="coursera.machine-learning.iYR2y", source=bad)), bad


def test_coursera_source_url_must_name_this_lecture():
    for bad in (
        "http://www.coursera.org/learn/machine-learning/lecture/iYR2y",
        "https://coursera.org/learn/machine-learning/lecture/iYR2y",
        "https://www.coursera.org/learn/machine-learning/lecture/other",  # other lecture
        "https://www.coursera.org/learn/other-course/lecture/iYR2y",  # same item id, other course
        "https://www.coursera.org/learn/machine-learning/",
        UDEMY_URL, NETFLIX_URL, "javascript:alert(1)", "", None, 42,
    ):
        assert schema.validate_raw(mod(**dict(COURSERA, sourceUrl=bad))), bad
    assert schema.validate_raw(mod(sourceUrl=COURSERA_URL))  # YouTube id
    assert schema.validate_raw(mod(**dict(UDEMY, sourceUrl=COURSERA_URL)))


def test_lesson_coursera_source_fields():
    les = dict(_lesson(), **COURSERA)
    assert schema.validate_lesson(les) == []
    assert schema.validate_lesson(dict(les, source="udemy"))
    assert schema.validate_lesson(dict(les, sourceUrl=COURSERA_URL.replace("iYR2y", "other")))


REF = {"lang": "zh-Hant", "kind": "official",
       "events": [{"t": 0, "d": 1200, "text": "我們出發吧"}, {"t": 1500, "d": 800, "text": "往北走"}]}


def _ref(**kw):
    r = copy.deepcopy(REF)
    r.update(kw)
    return r


def _ref_ev(i, **kw):
    r = copy.deepcopy(REF)
    r["events"][i].update(kw)
    return r


def test_raw_ref_is_optional_and_accepted_when_valid():
    assert schema.validate_raw(mod(**NETFLIX, ref=REF)) == []
    assert schema.validate_raw(mod(ref=REF)) == []
    assert schema.validate_raw(mod(**NETFLIX, refStatus="missing")) == []
    assert schema.validate_raw(mod(**NETFLIX, refStatus="failed")) == []


def test_raw_ref_rejections():
    bad_refs = [
        "ref", None, [], {},
        _ref(lang="zh-Hans"), _ref(lang=None), _ref(kind="asr"), _ref(kind=None),
        _ref(events=[]), _ref(events=None), _ref(events="x"), _ref(events=["x"]),
        _ref_ev(0, t=True), _ref_ev(0, t=-1), _ref_ev(0, t=1.5), _ref_ev(0, t=None),
        _ref_ev(0, d=0), _ref_ev(0, d=-5), _ref_ev(0, d=False), _ref_ev(0, d=2.0),
        _ref_ev(1, t=0),  # not strictly increasing (equal)
        _ref_ev(0, text=""), _ref_ev(0, text=None), _ref_ev(0, text=42),
        _ref(events=[{"t": i, "d": 1, "text": "字"} for i in range(5001)]),  # > 5000 events
        _ref(events=[{"t": i, "d": 1, "text": "字" * 2001} for i in range(100)]),  # > 200k chars in total
    ]
    for bad in bad_refs:
        assert schema.validate_raw(mod(ref=bad)), repr(bad)[:120]
    descending = copy.deepcopy(REF)
    descending["events"].reverse()
    assert schema.validate_raw(mod(ref=descending))


def test_raw_ref_limits_are_inclusive():
    assert schema.validate_raw(mod(ref=_ref(events=[{"t": i, "d": 1, "text": "字"} for i in range(5000)]))) == []
    assert schema.validate_raw(mod(ref=_ref(events=[{"t": i, "d": 1, "text": "字" * 2000} for i in range(100)]))) == []


def test_raw_ref_status_rejections():
    for bad in ("ok", "", None, 1, "MISSING"):
        assert schema.validate_raw(mod(refStatus=bad)), bad


def test_lesson_never_carries_ref_or_ref_status():
    assert schema.validate_lesson(dict(_lesson(), ref=REF))
    assert schema.validate_lesson(dict(_lesson(), refStatus="missing"))
