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
