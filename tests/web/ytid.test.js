import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVideoId, canonicalUrl } from '../../web/ytid.js';

const table = JSON.parse(readFileSync(new URL('../fixtures/urls.json', import.meta.url), 'utf8'));

test('parseVideoId accepts every fixture row', () => {
  for (const [input, id] of table.accept) assert.equal(parseVideoId(input), id, JSON.stringify(input));
});
test('parseVideoId rejects every fixture row', () => {
  for (const input of table.reject) assert.equal(parseVideoId(input), null, JSON.stringify(input));
});
test('parseVideoId rejects non-strings', () => {
  assert.equal(parseVideoId(null), null);
  assert.equal(parseVideoId(undefined), null);
  assert.equal(parseVideoId(42), null);
});
test('canonicalUrl', () => {
  assert.equal(canonicalUrl('CR94QQXO_4s'), 'https://www.youtube.com/watch?v=CR94QQXO_4s');
});
