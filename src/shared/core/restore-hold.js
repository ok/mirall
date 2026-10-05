// The own bees this device may read but not append to, because they were restored and peers may
// hold a longer history of them (restore-hold-rules.js). Named by bee name and kept beside the store,
// next to identity.enc: an adoption writes it while the store is empty or set aside, and a store with
// no CORESTORE yet sweeps unknown top-level files into its database. bare-fs and bare-path load
// lazily, so the store, which reads the held set, stays loadable under plain Node.
import b4a from 'b4a'
import { writeFileAtomic } from './atomic-file.js'

export const RESTORE_HOLD_FILE = 'restore-hold.json'
export const PROFILE_BEE = 'profile'

let file = null
let held = new Set()
let released = new Set()
let source = 'key'

async function io() {
  return { fs: (await import('bare-fs')).default, path: (await import('bare-path')).default }
}

async function holdFile(storagePath) {
  const { path } = await io()
  return path.join(path.dirname(storagePath), RESTORE_HOLD_FILE)
}
// `source` says what the restore brought back: a backup folder restores data, a recovery key the
// identity alone. A file without one was written by a key adoption.
const encode = (names, from) => b4a.from(JSON.stringify({ v: 1, held: [...names], source: from }))

function parseHold(bytes) {
  try {
    const parsed = JSON.parse(b4a.toString(bytes))
    if (parsed?.v === 1 && Array.isArray(parsed.held) && parsed.held.every((n) => typeof n === 'string')) {
      return { held: parsed.held, source: parsed.source === 'backup' ? 'backup' : 'key' }
    }
  } catch {}
  return null
}

// A file that cannot be read holds the profile: reading it as "nothing held" would open the core
// for writes, which is the one outcome the hold exists to prevent.
export async function loadRestoreHold(storagePath) {
  const { fs } = await io()
  file = await holdFile(storagePath)
  held = new Set()
  released = new Set()
  source = 'key'
  if (!fs.existsSync(file)) return
  const parsed = parseHold(fs.readFileSync(file))
  held = new Set(parsed?.held ?? [PROFILE_BEE])
  source = parsed?.source ?? 'key'
}

export function isHeld(name) {
  return held.has(name)
}

export function heldNames() {
  return [...held].filter((name) => !released.has(name))
}

export function profileHeld() {
  return held.has(PROFILE_BEE)
}

export function restoreSource() {
  return source
}

/** @param {string} storagePath @param {string[]} names @param {'backup' | 'key'} from */
export async function writeRestoreHold(storagePath, names, from) {
  await writeFileAtomic(await holdFile(storagePath), encode(names, from))
}

// The profile, opened while held, stays read-only for this process, and restore mode stays on until the
// next worker: it keeps reading as held, and only the file changes. Any other bee is released here
// too, so its next open is writable.
export async function releaseHeld(name) {
  if (!file || !held.has(name) || released.has(name)) return
  released.add(name)
  if (name !== PROFILE_BEE) held.delete(name)
  const rest = [...held].filter((n) => !released.has(n))
  if (rest.length) await writeFileAtomic(file, encode(rest, source))
  else (await io()).fs.rmSync(file, { force: true })
}

export function resetRestoreHold() {
  file = null
  held = new Set()
  released = new Set()
  source = 'key'
}
