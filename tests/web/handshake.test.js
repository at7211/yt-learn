import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForAck, shouldApplyLiveStatus } from '../../web/handshake.js';

function rig() {
  const r = { handlers: new Set(), posts: 0, unsubs: 0 };
  r.post = () => { r.posts++; };
  r.listen = (h) => { r.handlers.add(h); return () => { r.unsubs++; r.handlers.delete(h); }; };
  r.emit = (m) => [...r.handlers].forEach((h) => h(m));
  return r;
}

test('ack within time resolves true', async () => {
  const r = rig();
  const p = waitForAck({ post: () => { r.post(); setTimeout(() => r.emit({ type: 'ytlearn:ack', version: '1' }), 10); }, listen: r.listen, timeoutMs: 500 });
  assert.equal(await p, true);
  assert.equal(r.posts, 1);
  assert.equal(r.unsubs, 1);
});

test('listener is registered before ping is posted (synchronous ack)', async () => {
  const r = rig();
  const p = waitForAck({ post: () => r.emit({ type: 'ytlearn:ack' }), listen: r.listen, timeoutMs: 500 });
  assert.equal(await p, true);
});

test('timeout resolves false and unsubscribes', async () => {
  const r = rig();
  assert.equal(await waitForAck({ post: r.post, listen: r.listen, timeoutMs: 30 }), false);
  assert.equal(r.unsubs, 1);
});

test('other messages are ignored', async () => {
  const r = rig();
  const p = waitForAck({ post: () => { r.post(); r.emit({ type: 'ytlearn:status' }); r.emit(null); }, listen: r.listen, timeoutMs: 30 });
  assert.equal(await p, false);
});

test('duplicate acks stay true, unsubscribe once', async () => {
  const r = rig();
  const p = waitForAck({ post: () => { r.post(); r.emit({ type: 'ytlearn:ack' }); r.emit({ type: 'ytlearn:ack' }); }, listen: r.listen, timeoutMs: 500 });
  assert.equal(await p, true);
  r.emit({ type: 'ytlearn:ack' });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.unsubs, 1);
});

test('shouldApplyLiveStatus only before the server leaves capturing', () => {
  assert.equal(shouldApplyLiveStatus('queued'), true);
  assert.equal(shouldApplyLiveStatus('capturing'), true);
  for (const st of ['captured', 'building', 'done', 'error', undefined, null]) assert.equal(shouldApplyLiveStatus(st), false, String(st));
});
