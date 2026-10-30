// Click a subtitle word → Cambridge English–Chinese (Traditional) dictionary. Pure helpers, no DOM
// access beyond walking the clicked node's ancestors. web/dict.js and extension/dict.js must stay
// byte-identical (tests/web/extension-copies.test.js).

const DICT_BASE = 'https://dictionary.cambridge.org/dictionary/english-chinese-traditional/';

// Leading/trailing characters that are never part of a headword: ASCII punctuation except the
// apostrophe and hyphen kept inside words, plus curly quotes, dashes, ellipsis and CJK brackets.
const EDGE = /^[\s"'`.,;:!?()[\]{}<>«»“”‘’„‟‹›…–—\-_/\\|*~^#@$%&+=「」『』（）【】《》〈〉，。！？；：]+|[\s"'`.,;:!?()[\]{}<>«»“”‘’„‟‹›…–—\-_/\\|*~^#@$%&+=「」『』（）【】《》〈〉，。！？；：]+$/g;

// "concepts." → "concepts", "“AI”" → "ai", "don't," → "don't", "1.5" → "".
// Inner apostrophes (straight or curly) and hyphens are kept; a curly apostrophe becomes "'".
export function dictWord(token) {
  if (typeof token !== 'string') return '';
  const w = token.replace(EDGE, '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').toLowerCase();
  if (!w || !/\p{L}/u.test(w)) return ''; // nothing left, or a number like 1.5 / 2,000 / 90%
  return w;
}

// "proof of concepts" → .../english-chinese-traditional/proof-of-concepts
export function dictUrl(word) {
  return DICT_BASE + encodeURIComponent(String(word).trim().replace(/\s+/g, '-'));
}

// The text a click on the English subtitle line should look up: the vocab term of a .kw span
// (data-term, else its text), or the token of a .w span. '' when the click was not on a word.
// `target` is the event target; only classList / dataset / textContent / parentElement are used.
export function clickWord(target) {
  for (let n = target, depth = 0; n && depth < 4; n = n.parentElement, depth++) {
    const cl = n.classList;
    if (!cl || typeof cl.contains !== 'function') continue;
    if (cl.contains('kw')) return (n.dataset && n.dataset.term) || n.textContent || '';
    if (cl.contains('w')) return n.textContent || '';
    if (cl.contains('sub-en')) return '';
  }
  return '';
}
