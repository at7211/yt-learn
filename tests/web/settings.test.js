import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PRESETS, MODELS, normalize, presetOf, summary, shortModel, modelsFor, fmtUsd, budgetText } from '../../web/settings.js';

test('defaults and every preset pass normalize unchanged', () => {
  assert.deepEqual(normalize(DEFAULTS), { settings: DEFAULTS, errors: [] });
  for (const p of Object.values(PRESETS)) {
    assert.deepEqual(normalize(p.settings), { settings: { ...p.settings, provider: 'claude-cli', budgetUsd: null }, errors: [] });
  }
  assert.deepEqual(PRESETS.standard.settings, { model: DEFAULTS.model, effort: DEFAULTS.effort, workers: DEFAULTS.workers });
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
  assert.deepEqual(settings, { model: DEFAULTS.model, workers: 4, provider: 'claude-cli', budgetUsd: null });
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
  assert.equal(shortModel('claude-opus-6-0'), 'claude-opus-6-0'); // a listed API model keeps its full name
  assert.equal(summary(DEFAULTS), '設定：Claude CLI・標準・sonnet・4 併行');
  assert.equal(summary(PRESETS.fast.settings), '設定：Claude CLI・快・haiku・effort low・8 併行');
  assert.equal(summary(PRESETS.fine.settings), '設定：Claude CLI・細緻・opus・effort high・4 併行');
  assert.equal(summary({ model: 'claude-opus-5-5', effort: 'default', workers: 2 }), '設定：Claude CLI・自訂・opus・2 併行');
});

test('normalize validates model per provider and budget', () => {
  const base = { provider: 'openai-api', model: 'gpt-6-astra', effort: 'default', workers: 4, budgetUsd: null };
  assert.ok(normalize(base, {}).errors.some((e) => e.includes('測試連線')));
  assert.deepEqual(normalize(base, { openai: ['gpt-6-astra'] }).errors, []);
  assert.deepEqual(normalize({ ...base, provider: 'codex-cli', model: 'whatever' }).errors, []);
  assert.ok(normalize({ ...base, provider: 'anthropic-api', model: 'claude-x' }).errors.length);
  const cli = { ...base, provider: 'claude-cli', model: 'claude-sonnet-5-5' };
  assert.deepEqual(normalize(cli).errors, []);
  assert.ok(normalize({ ...cli, budgetUsd: 0 }).errors.length);
  assert.equal(normalize({ ...cli, budgetUsd: 2.5 }).settings.budgetUsd, 2.5);
});
test('modelsFor, summary with provider, fmtUsd, budgetText', () => {
  assert.deepEqual(modelsFor('anthropic-api', { anthropic: ['claude-opus-6-0'] }), [...MODELS, 'claude-opus-6-0']);
  assert.deepEqual(modelsFor('codex-cli', {}), []);
  assert.equal(summary({ provider: 'openai-api', model: 'gpt-6-astra', effort: 'default', workers: 4, budgetUsd: null }), '設定：OpenAI API・自訂・gpt-6-astra・4 併行');
  assert.equal(fmtUsd(0.1234), '約 $0.12'); assert.equal(fmtUsd(null), '牌價未知');
  assert.equal(budgetText({ apiUsd: 0.85, budgetUsd: 1 }), '本月 API 約 $0.85／上限 $1.00（本機估算）');
  assert.equal(budgetText({ apiUsd: 0.85, budgetUsd: null }), '本月 API 約 $0.85（本機估算）');
});

test('budgetText names API builds whose price is unknown', () => {
  assert.equal(budgetText({ apiUsd: 0.85, budgetUsd: 1, unpricedApiRows: 2 }),
    '本月 API 約 $0.85／上限 $1.00（本機估算）・本月有 2 次產課牌價未知，未計入上限');
  assert.equal(budgetText({ apiUsd: 0.85, budgetUsd: 1, unpricedApiRows: 0 }), '本月 API 約 $0.85／上限 $1.00（本機估算）');
});
