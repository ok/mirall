import os from 'os'
import fs from 'fs'
import path from 'path'
import { scaled } from './timing.js'

function uniq (label) {
  // Hex (not base36) for the random suffix: a base36 name can contain a cloud-sync hint
  // substring like "box"/"mega", which mount-validate rejects (MOUNT_FORBIDDEN_CLOUD_SYNC),
  // flaking any flow test that mounts the dir. Hex (0-9a-f) can't form any of those hints.
  return path.join(os.tmpdir(), `mirall-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`)
}

// Recursive on-disk byte total of a directory (shared by the store-growth/disk
// assertions across flow tests).
export function dirSize (dir) {
  let total = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSize(p)
      else if (e.isFile()) total += fs.statSync(p).size
    } catch {}
  }
  return total
}

export function writeTmpFile (bytes, t) {
  const p = uniq('src') + '.bin'
  fs.writeFileSync(p, bytes)
  if (t) t.teardown(() => { try { fs.rmSync(p) } catch {} })
  return p
}

export function mkTmpDir (t) {
  const d = uniq('dir')
  fs.mkdirSync(d, { recursive: true })
  if (t) t.teardown(() => { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} })
  return d
}

// A peer's storage path, nested one level like production (<userData>/app-storage). identity.enc
// and space-keys.enc are written to dirname(storage), so a flat tmp dir would put every peer's
// in the SHARED tmp root — where two peers with different KEKs collide on one envelope and the
// second fails to boot with "space-keys: unlock failed".
export function mkStoreDir (t) {
  return path.join(mkTmpDir(t), 'app-storage')
}

export function patternedBytes (n, seed = 7) {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * seed + 13) & 0xff
  return b
}

// Poll until a path exists (present=true) or is gone (present=false). Folder
// flow tests inject fs events, then wait for the mirror's tick to land/remove a
// file on disk — there's no completion event for "the tick ran", so we poll.
export async function waitForFile (p, { present = true, ms = 90000, every = 500 } = {}) {
  const deadline = scaled(ms)
  const start = Date.now()
  for (;;) {
    if (fs.existsSync(p) === present) return
    if (Date.now() - start > deadline) {
      throw new Error(`timeout waiting for ${p} present=${present} after ${deadline}ms (actually present=${fs.existsSync(p)})`)
    }
    await new Promise((r) => setTimeout(r, every))
  }
}
