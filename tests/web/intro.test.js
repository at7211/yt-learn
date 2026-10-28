import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introRows } from '../../web/intro.js';

test('introRows splits the title on newlines and trims', () => {
  assert.deepEqual(introRows({ title: ' 2023 年 11 月 14 日 \n參議院勞工委員會', lines: [' 參議員 Mullin 質詢 ', '工會會長 O\'Brien 作證'] }),
    { title: ['2023 年 11 月 14 日', '參議院勞工委員會'], lines: ['參議員 Mullin 質詢', '工會會長 O\'Brien 作證'] });
});

test('introRows returns null for missing or malformed data', () => {
  for (const bad of [undefined, null, 'x', 42, {}, { title: 1, lines: [] }, { title: 'a', lines: 'b' }, { title: ' \n ', lines: ['x'] }]) {
    assert.equal(introRows(bad), null);
  }
});

test('introRows drops non-string and blank lines but keeps the card', () => {
  assert.deepEqual(introRows({ title: 'T', lines: [3, '', ' ok '] }), { title: ['T'], lines: ['ok'] });
});
