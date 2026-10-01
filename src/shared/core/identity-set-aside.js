import fs from 'bare-fs'
import path from 'bare-path'
import { SECRET_FILE } from '../contract/secret-files.js'
import { RESTORE_HOLD_FILE } from './restore-hold.js'

// Moving a locked identity out of the way: the store and the files that belong to it (its envelopes
// and a restore's hold) go into a dated folder beside the store, so the next boot is a fresh install
// and nothing is deleted — a recovery key found later still opens the set-aside copy. The store directory itself stays (the
// data-dir tripwire guards it); only its entries move. The KEK and the relay seed stay wherever they
// are: they belong to the device, the next identity is sealed under the same KEK, and the relay seed
// belongs to no identity. All or nothing: a move that fails part-way is undone, so no folder ever
// holds half an identity.
const DEVICE_FILES = new Set([SECRET_FILE.KEK, SECRET_FILE.RELAY_TICKET])
const IDENTITY_FILES = [SECRET_FILE.IDENTITY, SECRET_FILE.SPACE_KEYS, RESTORE_HOLD_FILE]

function stamp(date) {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
}

function freeFolder(dataDir, date) {
  const base = path.join(dataDir, `app-storage.locked-${stamp(date)}`)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    if (!fs.existsSync(candidate)) return candidate
  }
}

function plannedMoves(storagePath, folder) {
  const dataDir = path.dirname(storagePath)
  const moves = fs.readdirSync(storagePath)
    .filter((entry) => !DEVICE_FILES.has(entry))
    .map((entry) => [path.join(storagePath, entry), path.join(folder, entry)])
  const inside = new Set(moves.map(([, to]) => path.basename(to)))
  for (const name of IDENTITY_FILES) {
    const beside = path.join(dataDir, name)
    if (fs.existsSync(beside)) moves.push([beside, path.join(folder, inside.has(name) ? `beside-${name}` : name)])
  }
  return moves
}

/** @internal `rename` is a test seam: production always moves with bare-fs. */
export function setAsideLockedData(storagePath, { now = new Date(), rename = fs.renameSync } = {}) {
  const folder = freeFolder(path.dirname(storagePath), now)
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  const done = []
  try {
    for (const [from, to] of plannedMoves(storagePath, folder)) {
      rename(from, to)
      done.push([from, to])
    }
  } catch (err) {
    const stranded = []
    for (const [from, to] of done.reverse()) {
      try { fs.renameSync(to, from) } catch { stranded.push(to) }
    }
    if (stranded.length) {
      err.message += `; could not move back, still in ${folder}: ${stranded.map((p) => path.basename(p)).join(', ')}`
    } else {
      fs.rmdirSync(folder)
    }
    throw err
  }
  return folder
}
