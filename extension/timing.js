// Pure timing functions for the player. No DOM. All times in seconds.
// A cue is visible during [words[a].t, words[b].e). A hit is active during
// [words[hit.a].t, words[hit.b].e), or its whole cue's span when
// words[hit.a].timed === false.

export function cueIndexAt(cues, words, t) {
  // Cues are contiguous and in time order: binary search the last cue starting <= t.
  let lo = 0, hi = cues.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[cues[mid].a].t <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (found < 0) return -1;
  return t < words[cues[found].b].e ? found : -1;
}

export function flattenHits(vocab, words) {
  const out = [];
  for (const v of vocab) {
    v.hits.forEach((h, hitIdx) => {
      out.push({ vocabId: v.id, hitIdx, cue: h.cue, a: h.a, b: h.b, start: words[h.a].t });
    });
  }
  out.sort((x, y) => x.start - y.start || x.a - y.a);
  return out;
}

function hitSpan(h, cues, words) {
  if (words[h.a].timed === false) {
    const c = cues[h.cue];
    return [words[c.a].t, words[c.b].e];
  }
  return [words[h.a].t, words[h.b].e];
}

export function activeHitAt(flatHits, cues, words, t) {
  // flatHits is sorted by start, so the last active one has the latest start.
  let best = null;
  for (const h of flatHits) {
    const [s, e] = hitSpan(h, cues, words);
    if (s <= t && t < e) best = h;
  }
  return best ? { vocabId: best.vocabId, hitIdx: best.hitIdx } : null;
}

function lastStartedIndex(flatHits, t) {
  let lo = 0, hi = flatHits.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flatHits[mid].start <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

export function panelState(flatHits, words, t, size = 5) {
  const n = flatHits.length;
  const current = lastStartedIndex(flatHits, t);
  const count = Math.min(size, n);
  const first = Math.max(0, Math.min(current - Math.floor(size / 2), n - count));
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(first + i);
  return { current, rows };
}

export function seenCount(flatHits, words, t) {
  const seen = new Set();
  for (const h of flatHits) {
    if (h.start > t) break;
    seen.add(h.vocabId);
  }
  return seen.size;
}
