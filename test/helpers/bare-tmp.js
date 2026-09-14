// The Bare twin of the temp-dir maker in test/helpers/fixtures.js, for test/integration and the
// Bare helpers. Hex, not base36, for the random suffix: base36 draws from [0-9a-z], so a name can
// spell a cloud-sync hint substring like "box" or "mega", and mount-validate rejects such a path
// with MOUNT_FORBIDDEN_CLOUD_SYNC — a rare, unreproducible red with no relation to the behavior
// under test. Hex (0-9a-f) cannot form any of those hints, so the hazard is gone by construction.
// test/unit/tmp-dir-suffix-hygiene.test.js pins both halves.
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
