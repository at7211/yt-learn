// extension/ytid.js must agree with pipeline/jobs.py::parse_video_id on the shared table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/ytid.js', import.meta.url), 'utf8');
const TABLE = JSON.parse(readFileSync(new URL('../fixtures/urls.json', import.meta.url), 'utf8'));
const ctx = { URL };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx);

test('accepts every url in the shared table', () => {
  for (const [input, id] of TABLE.accept) assert.equal(ctx.ytLearnParseVideoId(input), id, JSON.stringify(input));
});

test('rejects every url in the shared table', () => {
  for (const input of TABLE.reject) assert.equal(ctx.ytLearnParseVideoId(input), null, JSON.stringify(input));
});

test('non-strings rejected; canonical url', () => {
  assert.equal(ctx.ytLearnParseVideoId(undefined), null);
  assert.equal(ctx.ytLearnParseVideoId(42), null);
  assert.equal(ctx.ytLearnCanonicalUrl('puh91fohvTA'), 'https://www.youtube.com/watch?v=puh91fohvTA');
});
