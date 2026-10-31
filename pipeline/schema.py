"""Validation for the raw caption capture format (data/raw/<videoId>.json)."""
from .ids import LESSON_ID_RE, parse_udemy_url, source_of

VIDEO_ID_RE = LESSON_ID_RE  # old name
REQUIRED_META = ("title", "channel", "duration", "lang", "kind")


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _source_errors(obj, vid) -> list[str]:
    """Optional `source` / `sourceUrl`. sourceUrl is an outbound link from imported JSON, so it is
    only allowed for Udemy ids and must be that very lecture's URL; YouTube ids carry no sourceUrl."""
    errs = []
    src = source_of(vid)
    if "source" in obj and obj["source"] != src:
        errs.append(f"source must be {src!r} for videoId {vid!r}")
    if "sourceUrl" in obj:
        url = obj["sourceUrl"]
        if src != "udemy":
            errs.append("sourceUrl is only allowed for udemy.<lectureId> videoIds")
        else:
            parsed = parse_udemy_url(url)
            if parsed is None:
                errs.append("sourceUrl must be https://www.udemy.com/course/<slug>/learn/lecture/<id>")
            elif f"udemy.{parsed[1]}" != vid:
                errs.append("sourceUrl lecture id must match videoId")
    return errs


def validate_raw(obj) -> list[str]:
    """Return a list of error messages; empty means valid."""
    if not isinstance(obj, dict):
        return ["payload must be a JSON object"]
    errs = []
    vid = obj.get("videoId")
    if not (isinstance(vid, str) and LESSON_ID_RE.fullmatch(vid)):
        errs.append(f"videoId must match {LESSON_ID_RE.pattern}")
    else:
        errs += _source_errors(obj, vid)
    for k in REQUIRED_META:
        if obj.get(k) in (None, ""):
            errs.append(f"missing required field: {k}")
    dur = obj.get("duration")
    if dur not in (None, "") and not (_is_num(dur) and dur >= 0):
        errs.append("duration must be a non-negative number")
    events = obj.get("events")
    if not isinstance(events, list) or not events:
        errs.append("events must be a non-empty list")
        return errs
    prev_t = -1
    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            errs.append(f"events[{i}] must be an object")
            continue
        t, d = ev.get("t"), ev.get("d")
        if not _is_int(t) or t < 0:
            errs.append(f"events[{i}].t must be a non-negative int")
        elif t < prev_t:
            errs.append(f"events[{i}].t={t} is earlier than previous event ({prev_t})")
        else:
            prev_t = t
        if not _is_int(d) or d < 0:
            errs.append(f"events[{i}].d must be a non-negative int")
        segs = ev.get("segs")
        if not isinstance(segs, list):
            errs.append(f"events[{i}].segs must be a list")
            continue
        for j, seg in enumerate(segs):
            if not (isinstance(seg, list) and len(seg) == 2):
                errs.append(f"events[{i}].segs[{j}] must be a [offsetMs|null, text] pair")
                continue
            off, text = seg
            if off is not None and (not _is_int(off) or off < 0):
                errs.append(f"events[{i}].segs[{j}] offset must be null or a non-negative int")
            if not isinstance(text, str) or not text:
                errs.append(f"events[{i}].segs[{j}] text must be a non-empty string")
        if len(errs) > 50:
            errs.append("too many errors, stopping")
            break
    return errs


def validate_lesson(obj) -> list[str]:
    """Return a list of error messages for a lesson (data/lessons/<id>.json); empty means valid."""
    if not isinstance(obj, dict):
        return ["lesson must be a JSON object"]
    errs = []
    vid = obj.get("videoId")
    if not (isinstance(vid, str) and LESSON_ID_RE.fullmatch(vid)):
        errs.append(f"videoId must match {LESSON_ID_RE.pattern}")
    else:
        errs += _source_errors(obj, vid)
    for k in ("title", "channel", "lang", "generatedAt", "model"):
        if not (isinstance(obj.get(k), str) and obj[k]):
            errs.append(f"{k} must be a non-empty string")
    if not _is_int(obj.get("promptVersion")):
        errs.append("promptVersion must be an int")
    duration, covered = obj.get("duration"), obj.get("coveredSeconds")
    if not (_is_num(duration) and duration > 0):
        errs.append("duration must be a positive number")
        duration = None
    if not (_is_num(covered) and covered > 0):
        errs.append("coveredSeconds must be a positive number")
    elif duration is not None and covered > duration:
        errs.append("coveredSeconds must be <= duration")

    words = obj.get("words")
    if not isinstance(words, list) or not words:
        errs.append("words must be a non-empty list")
        words = None
    else:
        for i, w in enumerate(words):
            if not (isinstance(w, dict) and _is_num(w.get("t")) and _is_num(w.get("e"))
                    and isinstance(w.get("w"), str) and isinstance(w.get("timed"), bool)):
                errs.append(f"words[{i}] must be {{t, e, w, timed}} with numeric t/e")
            elif not 0 <= w["t"] <= w["e"]:
                errs.append(f"words[{i}] needs 0 <= t <= e")
            elif i and isinstance(words[i - 1], dict) and _is_num(words[i - 1].get("t")) \
                    and w["t"] < words[i - 1]["t"]:
                errs.append(f"words[{i}].t is earlier than words[{i - 1}].t")
            if len(errs) > 50:
                errs.append("too many errors, stopping")
                return errs

    cues = obj.get("cues")
    if not isinstance(cues, list) or not cues:
        errs.append("cues must be a non-empty list")
        cues = None
    else:
        expect = 0
        prev_start = None
        for i, c in enumerate(cues):
            if not (isinstance(c, dict) and _is_int(c.get("a")) and _is_int(c.get("b"))
                    and isinstance(c.get("tokens"), list) and isinstance(c.get("en"), str)
                    and isinstance(c.get("zh"), str)):
                errs.append(f"cues[{i}] must be {{a, b, en, tokens, zh}}")
                continue
            if c["a"] != expect or c["b"] < c["a"]:
                errs.append(f"cues[{i}] must start at word {expect} and have b >= a")
            elif len(c["tokens"]) != c["b"] - c["a"] + 1:
                errs.append(f"cues[{i}] tokens length must equal b-a+1")
            expect = c["b"] + 1
            if words is not None and 0 <= c["a"] < len(words) and prev_start is not None:
                start = words[c["a"]].get("t") if isinstance(words[c["a"]], dict) else None
                if _is_num(start) and start <= prev_start:
                    errs.append(f"cues[{i}] start time must be later than the previous cue's")
            if words is not None and 0 <= c["a"] < len(words) and isinstance(words[c["a"]], dict) \
                    and _is_num(words[c["a"]].get("t")):
                prev_start = words[c["a"]]["t"]
            if len(errs) > 50:
                errs.append("too many errors, stopping")
                return errs
        if words is not None and expect != len(words):
            errs.append(f"cues cover {expect} of {len(words)} words")

    vocab = obj.get("vocab")
    if not isinstance(vocab, list):
        errs.append("vocab must be a list")
        return errs
    for i, v in enumerate(vocab):
        if not (isinstance(v, dict) and v.get("id") == i and isinstance(v.get("term"), str)
                and isinstance(v.get("pos"), str) and isinstance(v.get("zh"), str)
                and (v.get("ipa") is None or isinstance(v.get("ipa"), str))
                and isinstance(v.get("hits"), list) and v["hits"]):
            errs.append(f"vocab[{i}] must be {{id=position, term, pos, ipa, zh, hits(non-empty)}}")
            continue
        for j, h in enumerate(v["hits"]):
            ok = isinstance(h, dict) and all(_is_int(h.get(k)) for k in ("cue", "a", "b"))
            if ok and cues is not None:
                ok = (0 <= h["cue"] < len(cues) and isinstance(cues[h["cue"]], dict)
                      and _is_int(cues[h["cue"]].get("a")) and _is_int(cues[h["cue"]].get("b"))
                      and cues[h["cue"]]["a"] <= h["a"] <= h["b"] <= cues[h["cue"]]["b"])
            if not ok:
                errs.append(f"vocab[{i}].hits[{j}] must be a span inside its cue")
        if len(errs) > 50:
            errs.append("too many errors, stopping")
            break
    if "intro" in obj:  # optional card; absent on lessons built before it existed
        from .intro import validate_intro
        errs += ["intro: " + e for e in validate_intro(obj["intro"])]
    return errs
