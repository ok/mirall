// Identity changes asked for while the store is open: a recovery key adopted on a fresh install, a
// restore set aside, and a backup restored. A store's files cannot move under an open database, so
// they wait for the next worker and run here, before it opens the store. Every step is safe to repeat
// and the request is removed last, so a crash part-way is finished by the next boot.
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { SECRET_FILE } from '../contract/secret-files.js'
import { setAsideLockedData } from './identity-set-aside.js'
import { writeRestoreHold, PROFILE_BEE } from './restore-hold.js'
import { writeFileAtomic } from './atomic-file.js'

export const ADOPT_FILE = 'identity-adopt.enc'
const SET_ASIDE_REQUEST = 'set-aside.pending'
const RESTORE_REQUEST = 'restore-pending.json'
export const STAGING_DIR = 'app-storage.restoring'
const CORESTORE = 'CORESTORE'

export function stagingPath(storagePath) {
  return path.join(path.dirname(storagePath), STAGING_DIR)
}

function holdsIdentityData(storagePath) {
  const besideIdentity = path.join(path.dirname(storagePath), SECRET_FILE.IDENTITY)
  return fs.existsSync(besideIdentity) || (fs.existsSync(storagePath) && fs.readdirSync(storagePath).length > 0)
}

function setAsideIfHeld(storagePath) {
  if (!holdsIdentityData(storagePath)) return null
  fs.mkdirSync(storagePath, { recursive: true })
  return setAsideLockedData(storagePath)
}

// A key adopted or a backup staged without reaching a restart, dropped whole: the request, the staging
// store and the identity sealed for it. Setting up the fresh identity, or adopting another key, is the
// user choosing that over it. Only ever called on a running worker, so the next boot's move has not
// begun.
export function cancelPendingRestore(storagePath) {
  const dataDir = path.dirname(storagePath)
  fs.rmSync(path.join(dataDir, RESTORE_REQUEST), { force: true })
  fs.rmSync(stagingPath(storagePath), { recursive: true, force: true })
  fs.rmSync(path.join(dataDir, ADOPT_FILE), { force: true })
}

// Written after the staging store is complete and the identity is sealed into the adoption file: this
// is the point from which the next boot replaces the data.
export async function requestRestore(storagePath, { hold }) {
  await writeFileAtomic(path.join(path.dirname(storagePath), RESTORE_REQUEST), b4a.from(JSON.stringify({ hold })))
}

function readRestoreRequest(file) {
  try {
    const { hold } = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (Array.isArray(hold) && hold.every((name) => typeof name === 'string')) return hold
  } catch {}
  return null
}

// The staging store's entries move in with CORESTORE last, so while staging still has it the move has
// not finished, and the live store's own CORESTORE (or identity) means its data is still there to set
// aside.
// A request that cannot be read was never completed (it is written atomically after everything else),
// so the restore is dropped and the device boots as it was.
async function applyRestore(storagePath, request) {
  const dataDir = path.dirname(storagePath)
  const staging = stagingPath(storagePath)
  const hold = readRestoreRequest(request)
  if (!hold) {
    cancelPendingRestore(storagePath)
    return null
  }
  let folder = null
  if (fs.existsSync(path.join(staging, CORESTORE))) {
    if (fs.existsSync(path.join(storagePath, CORESTORE)) || fs.existsSync(path.join(dataDir, SECRET_FILE.IDENTITY))) folder = setAsideIfHeld(storagePath)
    fs.mkdirSync(storagePath, { recursive: true })
    for (const entry of fs.readdirSync(staging).filter((name) => name !== CORESTORE)) {
      fs.renameSync(path.join(staging, entry), path.join(storagePath, entry))
    }
    fs.renameSync(path.join(staging, CORESTORE), path.join(storagePath, CORESTORE))
  }
  if (fs.existsSync(staging)) fs.rmdirSync(staging)
  await writeRestoreHold(storagePath, hold)
  const adopt = path.join(dataDir, ADOPT_FILE)
  if (fs.existsSync(adopt)) fs.renameSync(adopt, path.join(dataDir, SECRET_FILE.IDENTITY))
  fs.rmSync(request)
  return folder
}

export function requestSetAside(storagePath) {
  fs.writeFileSync(path.join(path.dirname(storagePath), SET_ASIDE_REQUEST), b4a.alloc(0))
}

// The adopted identity starts with its profile held: this device holds none of it, and the peers
// that do must be caught up with before anything is written (restore-hold.js).
export async function applyPendingIdentityChange(storagePath) {
  const dataDir = path.dirname(storagePath)
  const restore = path.join(dataDir, RESTORE_REQUEST)
  if (fs.existsSync(restore)) return applyRestore(storagePath, restore)
  const request = path.join(dataDir, SET_ASIDE_REQUEST)
  const adopt = path.join(dataDir, ADOPT_FILE)
  let folder = null
  if (fs.existsSync(request)) {
    folder = setAsideIfHeld(storagePath)
    fs.rmSync(request)
  }
  if (fs.existsSync(adopt)) {
    folder = setAsideIfHeld(storagePath) ?? folder
    await writeRestoreHold(storagePath, [PROFILE_BEE])
    fs.renameSync(adopt, path.join(dataDir, SECRET_FILE.IDENTITY))
  }
  return folder
}
