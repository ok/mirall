import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The Node twin of bare-tmp.js. Hex, never base36: a base36 name draws from [0-9a-z] and can spell
// a cloud-sync hint substring like "box" or "mega", which mount-validate rejects with
// MOUNT_FORBIDDEN_CLOUD_SYNC — a rare, unreproducible red unrelated to the behaviour under test.
// test/unit/tmp-dir-suffix-hygiene.test.js pins both halves.

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
