import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PRESETS, normalize, presetOf, summary, shortModel } from '../../web/settings.js';

test('defaults and every preset pass normalize unchanged', () => {
  assert.deepEqual(normalize(DEFAULTS), { settings: DEFAULTS, errors: [] });
  for (const p of Object.values(PRESETS)) assert.deepEqual(normalize(p.settings), { settings: p.settings, errors: [] });
  assert.deepEqual(PRESETS.standard.settings, DEFAULTS);
});

test('normalize rejects what the server rejects', () => {
  const bad = [
    { ...DEFAULTS, model: 'gpt-4' },
    { ...DEFAULTS, effort: 'huge' },
    { ...DEFAULTS, workers: 0 },
    { ...DEFAULTS, workers: 9 },
    { ...DEFAULTS, workers: 2.5 },
    { ...DEFAULTS, workers: '4' },
    { ...DEFAULTS, workers: true },
    { model: DEFAULTS.model, effort: 'default' },
    { ...DEFAULTS, extra: 1 },
  ];
  for (const b of bad) assert.ok(normalize(b).errors.length > 0, JSON.stringify(b));
  for (const b of [null, [], 'x', 3]) assert.ok(normalize(b).errors.length > 0);
  const { settings } = normalize({ ...DEFAULTS, effort: 'huge' });
  assert.deepEqual(settings, { model: DEFAULTS.model, workers: 4 });
});

test('presetOf names the three presets and returns null for a custom mix', () => {
  assert.equal(presetOf({ model: 'claude-haiku-5-5', effort: 'low', workers: 8 }), 'fast');
  assert.equal(presetOf({ model: 'claude-sonnet-5-5', effort: 'default', workers: 4 }), 'standard');
  assert.equal(presetOf({ model: 'claude-opus-5-5', effort: 'high', workers: 4 }), 'fine');
  assert.equal(presetOf({ model: 'claude-opus-5-5', effort: 'high', workers: 5 }), null);
  assert.equal(presetOf(null), null);
});

test('summary text', () => {
  assert.equal(shortModel('claude-sonnet-5-5'), 'sonnet');
  assert.equal(summary(DEFAULTS), '設定：標準・sonnet・4 併行');
  assert.equal(summary(PRESETS.fast.settings), '設定：快・haiku・effort low・8 併行');
  assert.equal(summary(PRESETS.fine.settings), '設定：細緻・opus・effort high・4 併行');
  assert.equal(summary({ model: 'claude-opus-5-5', effort: 'default', workers: 2 }), '設定：自訂・opus・2 併行');
});
