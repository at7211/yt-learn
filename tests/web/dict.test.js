import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictWord, dictUrl, clickWord } from '../../web/dict.js';

const BASE = 'https://dictionary.cambridge.org/dictionary/english-chinese-traditional/';

test('dictWord: strips surrounding punctuation, quotes and brackets; lowercases', () => {
  assert.equal(dictWord('concepts.'), 'concepts');
  assert.equal(dictWord('“AI”'), 'ai');
  assert.equal(dictWord('"Hello,"'), 'hello');
  assert.equal(dictWord('(really?)'), 'really');
  assert.equal(dictWord('[laughs]'), 'laughs');
  assert.equal(dictWord('—well…'), 'well');
  assert.equal(dictWord('「OK」'), 'ok');
});

test('dictWord: keeps inner apostrophes and hyphens', () => {
  assert.equal(dictWord("don't,"), "don't");
  assert.equal(dictWord('don’t'), "don't");
  assert.equal(dictWord('sci-fi'), 'sci-fi');
  assert.equal(dictWord("'Rock-and-roll'!"), 'rock-and-roll');
});

test('dictWord: nothing left or a pure number -> empty', () => {
  for (const t of ['1.5', '2,000', '90%', '$5', '...', '--', '', '  ', '“”', null, undefined, 42]) {
    assert.equal(dictWord(t), '', String(t));
  }
  assert.equal(dictWord('1st'), '1st');
});

test('dictUrl: Cambridge english-chinese-traditional, spaces become hyphens, encoded', () => {
  assert.equal(dictUrl('concepts'), BASE + 'concepts');
  assert.equal(dictUrl('proof of concepts'), BASE + 'proof-of-concepts');
  assert.equal(dictUrl(dictWord('Proof of Concepts.')), BASE + 'proof-of-concepts');
  assert.equal(dictUrl("don't"), BASE + "don't");
  assert.equal(dictUrl('a/b?c'), BASE + 'a%2Fb%3Fc');
});

// Minimal stand-ins for DOM nodes: clickWord only reads classList / dataset / textContent / parentElement.
function node(cls, text, { term, parent } = {}) {
  const set = new Set(cls ? cls.split(' ') : []);
  return { classList: { contains: (c) => set.has(c) }, dataset: term ? { term } : {}, textContent: text, parentElement: parent || null };
}

test('clickWord: a .w token gives its text, a .kw span gives the vocab term (else its text)', () => {
  const en = node('sub-en', 'we built proof of concepts.');
  assert.equal(clickWord(node('w', 'built', { parent: en })), 'built');
  assert.equal(clickWord(node('kw', 'proof of concepts.', { term: 'proof of concept', parent: en })), 'proof of concept');
  assert.equal(clickWord(node('kw', 'concepts.', { parent: en })), 'concepts.');
});

test('clickWord: the line itself, other nodes and nothing -> empty', () => {
  const en = node('sub-en', 'we built it');
  assert.equal(clickWord(en), '');
  assert.equal(clickWord(node('prow', 'x')), '');
  assert.equal(clickWord(null), '');
  assert.equal(clickWord({}), '');
});

test('clickWord: a child inside a .kw span resolves to the span', () => {
  const kw = node('kw', 'machine learning', { term: 'machine learning' });
  assert.equal(clickWord(node('', 'learning', { parent: kw })), 'machine learning');
});
