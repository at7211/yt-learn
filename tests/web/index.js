// Entry so that `node --test tests/web/` works on Node 22 (a directory argument
// is resolved as a module, not globbed). Real tests live in *.test.js.
import './timing.test.js';
