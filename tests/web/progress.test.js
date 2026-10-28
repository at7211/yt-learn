import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barState } from '../../web/progress.js';

test('capture phases are indeterminate with elapsed seconds', () => {
  assert.deepEqual(barState(null, 3), { mode: 'indet', pct: 0, label: '正在建立工作…' });
  assert.deepEqual(barState({ state: 'queued' }, 4.9), { mode: 'indet', pct: 0, label: '擷取字幕中… 4 秒' });
  assert.equal(barState({ state: 'capturing' }, 12).label, '擷取字幕中… 12 秒');
  assert.deepEqual(barState({ state: 'captured' }, 1), { mode: 'indet', pct: 0, label: '等待產課…' });
});

test('building without progress is indeterminate; with progress it is a weighted percentage', () => {
  assert.deepEqual(barState({ state: 'building' }, 1), { mode: 'indet', pct: 0, label: '準備中…' });
  assert.deepEqual(barState({ state: 'building', progress: { phase: 'segment', done: 3, total: 12 } }, 1),
    { mode: 'det', pct: 25, label: '切句 3/9（25%）' });
  assert.equal(barState({ state: 'building', progress: { phase: 'vocab', done: 9, total: 12 } }, 1).label, '挑選單字（75%）');
  assert.equal(barState({ state: 'building', progress: { phase: 'intro', done: 11, total: 12 } }, 1).label, '前情提要（92%）');
  assert.equal(barState({ state: 'building', progress: { phase: 'finish', done: 12, total: 12 } }, 1).label, '收尾（100%）');
});

test('malformed progress never throws and yields 0%', () => {
  for (const p of [{ phase: 'segment' }, { phase: 'segment', done: 1, total: 0 }, { phase: 'x', done: 'a', total: 'b' }]) {
    const st = barState({ state: 'building', progress: p }, 1);
    assert.equal(st.mode, 'det');
    assert.equal(st.pct, 0);
  }
});

test('done and error', () => {
  assert.deepEqual(barState({ state: 'done' }, 99), { mode: 'done', pct: 100, label: '完成' });
  assert.deepEqual(barState({ state: 'error' }, 5, 40), { mode: 'error', pct: 40, label: '' });
  assert.equal(barState({ state: 'error' }, 5).pct, 0);
});
