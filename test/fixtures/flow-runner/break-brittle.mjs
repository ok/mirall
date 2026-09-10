// Fixture for test/unit/flow-runner.test.js: simulates a brittle release that no longer
// routes through the entry point test/flow-runner.mjs wraps. Loaded with `node --import`
// so it runs before the runner, which must then refuse to start rather than run unpatched.
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
delete require('brittle').Test.prototype._run
