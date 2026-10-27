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
