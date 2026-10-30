// The overlay content script loads timing.js, intro.js and dict.js from the extension package
// (it cannot import from the local server). They must stay byte-identical to web/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const name of ['timing.js', 'intro.js', 'dict.js']) {
  test('extension/' + name + ' is a byte-identical copy of web/' + name, () => {
    const web = readFileSync(new URL('../../web/' + name, import.meta.url));
    const ext = readFileSync(new URL('../../extension/' + name, import.meta.url));
    assert.ok(web.equals(ext), 'copy web/' + name + ' to extension/' + name);
  });
}
