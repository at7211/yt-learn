// Page <-> extension handshake, injectable for tests.
// post(): send the ping. listen(handler): register a message handler, return unsubscribe.
// Resolves true on the first ytlearn:ack, false on timeout. Always unsubscribes once.
export function waitForAck({ post, listen, timeoutMs }) {
  return new Promise((resolve) => {
    let done = false;
    let unsub = null;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (unsub) unsub();
      resolve(v);
    };
    unsub = listen((msg) => { if (msg && msg.type === 'ytlearn:ack') finish(true); });
    timer = setTimeout(() => finish(false), timeoutMs);
    try { post(); } catch (e) { /* a failed post just means no ack */ }
  });
}
