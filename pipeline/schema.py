"""Validation for the raw caption capture format (data/raw/<videoId>.json)."""
import re

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
REQUIRED_META = ("title", "channel", "duration", "lang", "kind")


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def validate_raw(obj) -> list[str]:
    """Return a list of error messages; empty means valid."""
    if not isinstance(obj, dict):
        return ["payload must be a JSON object"]
    errs = []
    vid = obj.get("videoId")
    if not (isinstance(vid, str) and VIDEO_ID_RE.fullmatch(vid)):
        errs.append("videoId must match ^[A-Za-z0-9_-]{11}$")
    for k in REQUIRED_META:
        if obj.get(k) in (None, ""):
            errs.append(f"missing required field: {k}")
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


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_lesson(obj) -> list[str]:
    """Return a list of error messages for a lesson (data/lessons/<id>.json); empty means valid."""
    if not isinstance(obj, dict):
        return ["lesson must be a JSON object"]
    errs = []
    vid = obj.get("videoId")
    if not (isinstance(vid, str) and VIDEO_ID_RE.fullmatch(vid)):
        errs.append("videoId must match ^[A-Za-z0-9_-]{11}$")
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
            if len(errs) > 50:
                errs.append("too many errors, stopping")
                return errs

    cues = obj.get("cues")
    if not isinstance(cues, list) or not cues:
        errs.append("cues must be a non-empty list")
        cues = None
    else:
        expect = 0
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
    return errs
