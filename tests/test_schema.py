import copy

from pipeline import schema

GOOD = {
    "videoId": "CR94QQXO_4s", "title": "T", "channel": "CTV News", "duration": 344,
    "lang": "en", "kind": "asr", "capturedAt": "2026-10-27T23:00:00+08:00", "chrome": "142.0.7444.60",
    "events": [
        {"t": 280, "d": 5160, "segs": [[0, "pretends"], [400, "like"], [560, "he's"], [840, "self-made"]]},
        {"t": 5600, "d": 2100, "segs": [[None, "what a clown"]]},
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
    for bad in ("344", True, -1, [1], {"a": 1}):
        assert schema.validate_raw(mod(duration=bad)), bad
    assert schema.validate_raw(mod(duration=344.5)) == []


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
    k = 4  # split the single fixture cue after word 3
    c2 = {**c, "a": k, "tokens": c["tokens"][k:], "en": " ".join(c["tokens"][k:])}
    c1 = {**c, "b": k - 1, "tokens": c["tokens"][:k], "en": " ".join(c["tokens"][:k])}
    les["cues"] = [c1, c2]
    les["vocab"] = []
    assert schema.validate_lesson(les) == []
    les["words"][k]["t"] = les["words"][0]["t"]
    les["words"][k]["e"] = max(les["words"][k]["e"], les["words"][k]["t"])
    assert any("cue" in e and "later" in e for e in schema.validate_lesson(les))
