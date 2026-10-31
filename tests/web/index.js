// Entry so that `node --test tests/web/` works on Node 22 (a directory argument
// is resolved as a module, not globbed). Real tests live in *.test.js.
import './timing.test.js';
import './capture.test.js';
import './extension-ytid.test.js';
import './ytid.test.js';
import './handshake.test.js';
import './intro.test.js';
import './progress.test.js';
import './extension-copies.test.js';
import './overlay-state.test.js';
import './extension-overlay-messages.test.js';
import './settings.test.js';
import './dict.test.js';
import './vtt.test.js';
import './udemy-capture.test.js';
import './lesson-source.test.js';
