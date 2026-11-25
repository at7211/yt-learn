import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
const YTID = readFileSync(new URL('../../extension/ytid.js', import.meta.url), 'utf8');

function load() {
  // Same shape as tests/web/extension-overlay-messages.test.js: a stub chrome whose on* hooks are inert.
  const on = () => ({ addListener() {} });
  const chrome = {
    runtime: { id: 'ext', getManifest: () => ({ version: '0' }), onMessage: on(), onMessageExternal: on(), onInstalled: on(), getURL: (p) => p },
    windows: { onRemoved: on() }, action: { onClicked: on() }, contextMenus: { onClicked: on(), removeAll: (cb) => cb && cb(), create() {} },
    tabs: { onRemoved: on(), onUpdated: on() }, storage: { local: { get: async () => ({}), set: async () => {} } },
    permissions: { onRemoved: on(), contains: async () => false }, scripting: { getRegisteredContentScripts: async () => [] },
  };
  const ctx = { chrome, console, fetch: async () => { throw new TypeError('no network'); }, setTimeout, clearTimeout, URL };
  ctx.globalThis = ctx;
  ctx.importScripts = () => vm.runInContext(YTID, ctx);
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

test('budget 402 gets a site-specific hint', () => {
  const { ytLearnAddError } = load();
  const j = { ok: false, code: 'budget', error: '本月 API 費用已達上限 $1.00（本機估算）' };
  assert.equal(ytLearnAddError(402, j, 'youtube'), '本月 API 費用已達上限 $1.00（本機估算）（到 yt-learn 首頁可以選擇仍要跑）');
  assert.equal(ytLearnAddError(402, j, 'udemy'), '本月 API 費用已達上限 $1.00（本機估算）（到 yt-learn 首頁調高或關閉每月上限後，再回這一頁重試）');
  assert.match(ytLearnAddError(500, { error: 'x' }, 'youtube'), /^加入工作失敗：/);
});
