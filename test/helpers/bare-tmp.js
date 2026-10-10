// The Bare twin of the temp-dir maker in test/helpers/fixtures.js, for test/integration and the
// Bare helpers: the one spelling of a temp-dir name, with a hex random suffix.
// test/unit/tmp-dir-suffix-hygiene.test.js pins it.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

// Separates two dirs made in the same millisecond, so no caller keeps its own counter.
let seq = 0

// A name under os.tmpdir() and nothing else — for a caller that must observe the path while it
// still does not exist. Everyone else wants tmpDir.
export function tmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${seq++}`)
}

// Pass `t` to have the directory removed on teardown.
export function tmpDir(prefix, t) {
  const dir = tmpPath(prefix)
  fs.mkdirSync(dir, { recursive: true })
  if (t) t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}
