// The recovery key kept in the backup folder, so the folder and its passphrase are all a restore needs.
// It is the same passphrase-sealed file a user can save anywhere. Each key is written under a new name
// that never replaces a file, and only this identity's older keys are removed, after it landed: the
// folder never holds a torn key or none at all, and another identity's key is never touched. The newest
// name is the current key.
import b4a from 'b4a'
import { readRecoveryHeader } from '../../contract/recovery-key.js'

export const KEYS_DIR = 'keys'
const KEY_NAME = /^recovery-\d{8}T\d{9}Z\.mirallkey$/

const stampOf = (createdAt) => createdAt.replace(/[-:.]/g, '')

// Every readable key in the folder, newest first.
export async function listFolderKeys(target) {
  const names = (await target.list(KEYS_DIR)).filter((name) => KEY_NAME.test(name)).sort().reverse()
  const keys = []
  for (const name of names) {
    const content = b4a.toString(await target.read(`${KEYS_DIR}/${name}`))
    const header = readRecoveryHeader(content)
    if (header) keys.push({ name, content, createdAt: header.createdAt, identityPub: header.identityPub })
  }
  return keys
}

export async function readFolderKey(target) {
  return (await listFolderKeys(target))[0] ?? null
}

export async function writeFolderKey(target, { content, createdAt, identityPub }) {
  const name = `recovery-${stampOf(createdAt)}.mirallkey`
  await target.putOnce(`${KEYS_DIR}/${name}`, b4a.from(content))
  for (const key of await listFolderKeys(target)) {
    if (key.name !== name && key.identityPub === identityPub) await target.remove(`${KEYS_DIR}/${key.name}`)
  }
}
