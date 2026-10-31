// extension/netflix-manifest.js in a vm context: suspect/summarize (new and old field names), track picking,
// and the three bridge validators. All manifests here are hand-written shapes, not Netflix data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/netflix-manifest.js', import.meta.url), 'utf8');
const plain = (x) => JSON.parse(JSON.stringify(x));

export function loadLib() {
  const ctx = { URL, TextEncoder, JSON, Object, Array, Number, String, Math };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}
const L = loadLib();

const U = (n) => `https://ipv4-c0${n}-tpe001-ix.1.oca.nflxvideo.net/?o=1&v=${n}&e=1767225600&t=sig${n}`;

// New (2026-07+) shape: textTracks + downloadables{fmt: {urls:[{url}]}}
function newTrack(lang, type, fmts, extra = {}) {
  const downloadables = {};
  fmts.forEach((f, i) => { downloadables[f] = { urls: [{ cdn_id: 1, url: U(i + lang.length) }] }; });
  return { bcp47: lang, trackType: type, displayName: lang + ' ' + type, isForcedNarrative: false, downloadables, ...extra };
}
// Old shape: timedtexttracks + ttDownloadables{fmt: {downloadUrls:{cdn: url}}}
function oldTrack(lang, type, fmts, extra = {}) {
  const ttDownloadables = {};
  fmts.forEach((f, i) => { ttDownloadables[f] = { downloadUrls: { 3001: U(i + 10), 3002: U(i + 20) } }; });
  return { language: lang, type, languageDescription: lang + ' old', isForcedNarrative: false, ttDownloadables, ...extra };
}

test('suspect: root or .result with a positive movieId and any track key', () => {
  assert.ok(L.ytLearnNetflixSuspect({ movieId: 81234567, textTracks: [] }));
  assert.ok(L.ytLearnNetflixSuspect({ movieId: 81234567, timedtexttracks: null }));
  assert.ok(L.ytLearnNetflixSuspect({ movieId: 81234567, audioTracks: 'whatever' }));
  assert.ok(L.ytLearnNetflixSuspect({ movieId: 81234567, audio_tracks: 1 }));
  const inner = { movieId: 1, textTracks: [] };
  assert.equal(L.ytLearnNetflixSuspect({ result: inner }), inner);
  for (const o of [null, 1, 'x', [], {}, { movieId: 1 }, { textTracks: [] }, { movieId: 0, textTracks: [] }, { movieId: -1, textTracks: [] },
    { movieId: 1.5, textTracks: [] }, { movieId: 'abc', textTracks: [] }, { result: { movieId: 1 } }, { result: [{ movieId: 1, textTracks: [] }] }]) {
    assert.equal(L.ytLearnNetflixSuspect(o), null, JSON.stringify(o));
  }
});

test('summarize: new field names (textTracks / downloadables / urls[].url); only imsc1.1 and dfxp-ls-sdh kept', () => {
  const m = { movieId: 81234567, duration: 1500000, textTracks: [
    newTrack('en', 'PRIMARY', ['imsc1.1', 'dfxp-ls-sdh', 'simplesdh', 'webvtt-lssdh-ios8']),
    newTrack('zh-Hant', 'PRIMARY', ['imsc1.1', 'nflx-cmisc']),
  ] };
  const s = plain(L.ytLearnNetflixSummarize(L.ytLearnNetflixSuspect({ result: m })));
  assert.equal(s.movieId, '81234567');
  assert.equal(s.durationMs, 1500000);
  assert.equal(s.tracks.length, 2);
  assert.deepEqual(Object.keys(s.tracks[0].formats), ['imsc1.1', 'dfxp-ls-sdh']);
  assert.deepEqual(Object.keys(s.tracks[1].formats), ['imsc1.1']);
  assert.deepEqual({ ...s.tracks[0], formats: undefined }, { lang: 'en', type: 'PRIMARY', name: 'en PRIMARY', forced: false, formats: undefined });
  assert.ok(s.tracks[0].formats['imsc1.1'].startsWith('https://ipv4-'));
});

test('summarize: old field names (timedtexttracks / ttDownloadables / downloadUrls{})', () => {
  const m = { movieId: '81234567', timedtexttracks: [oldTrack('en', 'ASSISTIVE', ['dfxp-ls-sdh']), { isNoneTrack: true, language: null }] };
  const s = plain(L.ytLearnNetflixSummarize(m));
  assert.equal(s.durationMs, null);
  assert.deepEqual(s.tracks, [{ lang: 'en', type: 'ASSISTIVE', name: 'en old', forced: false, formats: { 'dfxp-ls-sdh': U(10) } }]);
});

test('summarize: non-https, wrong host, userinfo, port and over-long URLs are dropped; the first good one wins', () => {
  const bad = ['http://ipv4-c001.1.oca.nflxvideo.net/?o=1', 'https://evil.example/?o=1', 'https://nflxvideo.net.evil.example/x',
    'https://user:pw@ipv4-c001.1.oca.nflxvideo.net/x', 'https://ipv4-c001.1.oca.nflxvideo.net:8443/x', 'https://.nflxvideo.net/x',
    'https://ipv4-c001.1.oca.nflxvideo.net/' + 'a'.repeat(2100), 'javascript:alert(1)', 42, null];
  const t = { bcp47: 'en', trackType: 'PRIMARY', downloadables: { 'imsc1.1': { urls: [...bad.map((url) => ({ url })), { url: U(7) }] } } };
  const s = L.ytLearnNetflixSummarize({ movieId: 5, textTracks: [t] });
  assert.equal(s.tracks[0].formats['imsc1.1'], U(7));
  const none = L.ytLearnNetflixSummarize({ movieId: 5, textTracks: [{ ...t, downloadables: { 'imsc1.1': { urls: bad.map((url) => ({ url })) } } }] });
  assert.deepEqual(plain(none.tracks[0].formats), {});
  for (const u of bad) assert.equal(L.ytLearnNfUrlOk(u), false, String(u).slice(0, 60));
  assert.equal(L.ytLearnNfUrlOk(U(1)), true);
});

test('summarize: forced flag, name capped at 128, tracks capped at 200; unknown shapes -> null', () => {
  const s = L.ytLearnNetflixSummarize({ movieId: 5, textTracks: [newTrack('en', 'PRIMARY', ['imsc1.1'], { isForcedNarrative: true, displayName: 'x'.repeat(300) })] });
  assert.equal(s.tracks[0].forced, true);
  assert.equal(s.tracks[0].name.length, 128);
  const many = L.ytLearnNetflixSummarize({ movieId: 5, textTracks: Array.from({ length: 250 }, () => newTrack('en', 'PRIMARY', ['imsc1.1'])) });
  assert.equal(many.tracks.length, 200);
  for (const m of [{ movieId: 5, audioTracks: [] }, { movieId: 5, textTracks: {} }, { movieId: 5, textTracks: 'x' }, { movieId: 0, textTracks: [] }, null]) {
    assert.equal(L.ytLearnNetflixSummarize(m), null, JSON.stringify(m));
  }
  // a renamed download map is not guessed at: the track is kept with no formats
  const renamed = L.ytLearnNetflixSummarize({ movieId: 5, textTracks: [{ bcp47: 'en', trackType: 'PRIMARY', subtitleFiles: { 'imsc1.1': U(1) } }] });
  assert.deepEqual(plain(renamed.tracks[0].formats), {});
});

test('pickTrack: non-forced English with a kept format; PRIMARY before ASSISTIVE; en/en-US before other en-*; imsc1.1 before dfxp-ls-sdh', () => {
  const tr = (lang, type, formats, forced = false) => ({ lang, type, name: '', forced, formats: Object.fromEntries(formats.map((f, i) => [f, U(i)])) });
  const P = L.ytLearnNetflixPickTrack;
  const a = P([tr('en', 'ASSISTIVE', ['imsc1.1']), tr('en-GB', 'PRIMARY', ['imsc1.1']), tr('en', 'PRIMARY', ['dfxp-ls-sdh', 'imsc1.1'])], 'en');
  assert.equal(a.track.lang, 'en');
  assert.equal(a.track.type, 'PRIMARY');
  assert.equal(a.format, 'imsc1.1');
  assert.equal(a.url, a.track.formats['imsc1.1']);
  assert.equal(P([tr('en', 'ASSISTIVE', ['imsc1.1']), tr('en-GB', 'PRIMARY', ['dfxp-ls-sdh'])], 'en').track.lang, 'en-GB');
  assert.equal(P([tr('en', 'PRIMARY', ['imsc1.1'], true), tr('en', 'ASSISTIVE', ['dfxp-ls-sdh'])], 'en').track.type, 'ASSISTIVE');
  assert.equal(P([tr('en', 'PRIMARY', [])], 'en'), null);
  assert.equal(P([tr('eng', 'PRIMARY', ['imsc1.1']), tr('fr', 'PRIMARY', ['imsc1.1'])], 'en'), null);
  assert.equal(P([tr('en_US', 'PRIMARY', ['imsc1.1'])], 'en').track.lang, 'en_US');
  assert.equal(P([], 'en'), null);
  assert.equal(P(null, 'en'), null);
  assert.equal(P([tr('zh-Hans', 'PRIMARY', ['imsc1.1']), tr('zh-Hant', 'PRIMARY', ['imsc1.1'])], 'zh-Hant').track.lang, 'zh-Hant');
});

/* ---------- validators ---------- */

const STATS = { parsed: 3, suspected: 1, summarized: 1, unknownShape: 0, skippedReviver: 0 };
const MANIFEST = { movieId: '81234567', durationMs: 1500000, tracks: [{ lang: 'en', type: 'PRIMARY', name: 'English', forced: false, formats: { 'imsc1.1': U(1) } }] };
const found = (over = {}) => ({ type: 'ytlearn:nf-manifest', nonce: 'n1', hook: 1, movieId: '81234567', state: 'found', manifest: plain(MANIFEST), stats: { ...STATS }, ...over });

test('validateRequest: nf-get / nf-seek / nf-off shapes', () => {
  const V = L.ytLearnNfValidateRequest;
  assert.equal(V({ type: 'ytlearn:nf-get', nonce: 'abc', movieId: '81234567' }), null);
  assert.equal(V({ type: 'ytlearn:nf-seek', requestId: 'r1', expectedMovieId: '81234567', ms: 0, play: false }), null);
  assert.equal(V({ type: 'ytlearn:nf-seek', requestId: 'r1', expectedMovieId: '81234567', ms: 123456, play: true }), null);
  assert.equal(V({ type: 'ytlearn:nf-off' }), null);
  for (const m of [null, 'x', {}, { type: 'ytlearn:nf-manifest' }, { type: 'ytlearn:nf-seek-ack' },
    { type: 'ytlearn:nf-get', nonce: '', movieId: '1' }, { type: 'ytlearn:nf-get', nonce: 'x'.repeat(257), movieId: '1' },
    { type: 'ytlearn:nf-get', nonce: 'a', movieId: 1 }, { type: 'ytlearn:nf-get', nonce: 'a', movieId: '1a' },
    { type: 'ytlearn:nf-seek', requestId: 'r', expectedMovieId: '1', ms: -1, play: false },
    { type: 'ytlearn:nf-seek', requestId: 'r', expectedMovieId: '1', ms: 1.5, play: false },
    { type: 'ytlearn:nf-seek', requestId: 'r', expectedMovieId: '1', ms: Infinity, play: false },
    { type: 'ytlearn:nf-seek', requestId: 'r', expectedMovieId: '1', ms: 1, play: 'true' },
    { type: 'ytlearn:nf-seek', requestId: 'r', expectedMovieId: '1', ms: 1, play: 1 },
    { type: 'ytlearn:nf-seek', expectedMovieId: '1', ms: 1, play: true }]) {
    assert.notEqual(V(m), null, JSON.stringify(m));
  }
});

test('validateGetReply: found / pending / unsupported / off and their required/forbidden fields', () => {
  const V = (m) => L.ytLearnNfValidateGetReply(m, '81234567');
  assert.equal(V(found()), null);
  assert.equal(V(found({ title: 'A title', show: 'A show', currentMs: 1234.5 })), null);
  for (const state of ['pending', 'unsupported', 'off']) {
    const m = found({ state });
    delete m.manifest;
    assert.equal(V(m), null, state);
    assert.notEqual(V(found({ state })), null, state + ' must not carry a manifest');
  }
  const noManifest = found();
  delete noManifest.manifest;
  assert.notEqual(V(noManifest), null);
  assert.notEqual(V(found({ state: 'weird' })), null);
  assert.notEqual(V(found({ hook: 2 })), null, 'hook version');
  assert.notEqual(V(found({ movieId: '1' })), null, 'reply for another movie');
  assert.notEqual(V(found({ manifest: { ...plain(MANIFEST), movieId: '1' } })), null, 'manifest for another movie');
  assert.notEqual(V(found({ stats: { parsed: 1 } })), null);
  assert.notEqual(V(found({ currentMs: -1 })), null);
  assert.notEqual(V(found({ title: 'x'.repeat(257) })), null);
  assert.notEqual(V(found({ type: 'ytlearn:nf-get' })), null);
});

test('validateGetReply: size, track count, format keys and URL rules', () => {
  const V = (m) => L.ytLearnNfValidateGetReply(m, '81234567');
  const withTracks = (tracks) => found({ manifest: { ...plain(MANIFEST), tracks } });
  const t = MANIFEST.tracks[0];
  assert.notEqual(V(withTracks([{ ...t, formats: { simplesdh: U(1) } }])), null, 'format key outside the allow-list');
  assert.notEqual(V(withTracks([{ ...t, formats: { 'imsc1.1': 'https://evil.example/x' } }])), null, 'hostname');
  assert.notEqual(V(withTracks([{ ...t, formats: { 'imsc1.1': 'http://a.nflxvideo.net/x' } }])), null, 'http');
  assert.notEqual(V(withTracks([{ ...t, formats: { 'imsc1.1': 'https://u@a.nflxvideo.net/x' } }])), null, 'userinfo');
  assert.notEqual(V(withTracks([{ ...t, formats: { 'imsc1.1': 'https://a.nflxvideo.net:444/x' } }])), null, 'port');
  assert.notEqual(V(withTracks([{ ...t, lang: 'x'.repeat(257) }])), null, 'string cap');
  assert.notEqual(V(withTracks([{ ...t, forced: 'no' }])), null);
  assert.notEqual(V(withTracks(Array.from({ length: 201 }, () => t))), null, '> 200 tracks');
  // 128 KB cap on the whole message, reported with the real size: 80 tracks with ~2000-char URLs exceed it
  const longUrl = 'https://a.nflxvideo.net/?' + 'q'.repeat(1990);
  assert.match(V(withTracks(Array.from({ length: 80 }, () => ({ ...t, formats: { 'imsc1.1': longUrl } })))), /^too large: \d{6} bytes$/);
  assert.equal(V(withTracks(Array.from({ length: 50 }, () => ({ ...t, formats: { 'imsc1.1': longUrl } })))), null, '~100 KB passes');
  // a realistic manifest: 50 tracks x 2 URLs x ~350 chars
  const realUrl = 'https://ipv4-c001-tpe001-ix.1.oca.nflxvideo.net/?' + 'o'.repeat(300);
  assert.equal(V(withTracks(Array.from({ length: 50 }, () => ({ ...t, formats: { 'imsc1.1': realUrl, 'dfxp-ls-sdh': realUrl } })))), null);
});

test('validateSeekAck: requestId, hook, ok, error', () => {
  const V = L.ytLearnNfValidateSeekAck;
  assert.equal(V({ type: 'ytlearn:nf-seek-ack', requestId: 'r1', hook: 1, ok: true }, 'r1'), null);
  assert.equal(V({ type: 'ytlearn:nf-seek-ack', requestId: 'r1', hook: 1, ok: false, error: 'off' }, 'r1'), null);
  assert.notEqual(V({ type: 'ytlearn:nf-seek-ack', requestId: 'r2', hook: 1, ok: true }, 'r1'), null);
  assert.notEqual(V({ type: 'ytlearn:nf-seek-ack', requestId: 'r1', ok: true }, 'r1'), null, 'ack always carries hook');
  assert.notEqual(V({ type: 'ytlearn:nf-seek-ack', requestId: 'r1', hook: 1, ok: 'yes' }, 'r1'), null);
  assert.notEqual(V({ type: 'ytlearn:nf-seek-ack', requestId: 'r1', hook: 1, ok: false, error: 'x'.repeat(300) }, 'r1'), null);
  assert.notEqual(V({ type: 'ytlearn:nf-manifest', requestId: 'r1', hook: 1, ok: true }, 'r1'), null);
});
