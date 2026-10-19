// The machine-only record of the organization this install accepted: beside the store, sealed under
// an M-derived key, moved aside with the identity files, and never in a backup (a backup run reads
// the vault and the settings only). A file that no longer opens is removed: management fails open.
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { SECRET_FILE, resolveSecretFile } from '../contract/secret-files.js'
import { seal, open } from '../core/identity-envelope.js'
import { writeFileAtomic } from '../core/atomic-file.js'

const AAD = b4a.from('mirall-managed|1')
const VERSION = 1
const STORE_DIR = 'managed-store'

const managedFile = (storagePath) => resolveSecretFile(storagePath, SECRET_FILE.MANAGED, { join: path.join, dirname: path.dirname, exists: fs.existsSync })
const writeTarget = (storagePath) => path.join(path.dirname(storagePath), SECRET_FILE.MANAGED)

export const managedStoreDir = (storagePath) => path.join(path.dirname(storagePath), STORE_DIR)
export const managedStateExists = (storagePath) => fs.existsSync(managedFile(storagePath))

export async function readManagedState(storagePath, key, log) {
  const file = managedFile(storagePath)
  if (!fs.existsSync(file)) return null
  try {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    const plain = open({ nonce: b4a.from(envelope.nonce, 'base64'), ciphertext: b4a.from(envelope.ciphertext, 'base64') }, key, AAD)
    const state = plain && JSON.parse(b4a.toString(plain))
    if (state?.v === VERSION) return state
  } catch {}
  log?.warn('managed configuration unreadable, removed')
  await removeManagedState(storagePath).catch((err) => log?.warn('unreadable managed configuration not removed:', err.message))
  return null
}

export async function writeManagedState(storagePath, key, state) {
  const { nonce, ciphertext } = seal(b4a.from(JSON.stringify({ ...state, v: VERSION })), key, AAD)
  const file = fs.existsSync(path.join(storagePath, SECRET_FILE.MANAGED)) ? path.join(storagePath, SECRET_FILE.MANAGED) : writeTarget(storagePath)
  await writeFileAtomic(file, JSON.stringify({ nonce: b4a.toString(nonce, 'base64'), ciphertext: b4a.toString(ciphertext, 'base64') }))
}

// Throws when the file is still there afterwards: a leave that cannot remove it must say so.
export async function removeManagedState(storagePath) {
  for (const file of [path.join(storagePath, SECRET_FILE.MANAGED), writeTarget(storagePath)]) {
    await fs.promises.rm(file, { force: true })
  }
}

export async function removeManagedStore(storagePath) {
  await fs.promises.rm(managedStoreDir(storagePath), { recursive: true, force: true })
}

// The link's apiUrl only bootstraps the first fetch; once a bundle is applied, the signed document is
// the only authority for the API address.
export const effectiveApiUrl = (state) => state.applied?.endpoints.apiUrl ?? state.apiUrl
