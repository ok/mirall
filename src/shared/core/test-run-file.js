// The test run file: one small JSON file beside settings.json, written whole by the test script and
// read once at worker start. It names a run and turns the transfer trace on; with no file the app
// runs as shipped. The worker never writes it.
import fs from 'bare-fs'
import path from 'bare-path'

export const TEST_RUN_FILE = 'transfer-test.json'

/** @param {string} storagePath @returns {{ testRun: object | null, broken: string | null }} */
export function loadTestRun(storagePath) {
  let raw
  try {
    raw = fs.readFileSync(path.join(path.dirname(storagePath), TEST_RUN_FILE), 'utf-8')
  } catch (err) {
    return { testRun: null, broken: err?.code === 'ENOENT' ? null : err?.message || String(err) }
  }
  try {
    return { testRun: JSON.parse(raw), broken: null }
  } catch (err) {
    return { testRun: null, broken: err?.message || String(err) }
  }
}
