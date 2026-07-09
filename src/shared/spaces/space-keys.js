// The SCK vault: per-space content keys (SCK — the key that encrypts a space's catalogs;
// holding it is read access) kept in memory and persisted to space-keys.enc, wrapped by
// a vault key derived from the master secret.
import b4a from 'b4a'
import { wrap, unwrap } from '../core/identity-envelope.js'
import { getSpaceKeysVaultKey, getStoragePath } from '../core/store.js'
import { writeFileAtomic } from '../core/atomic-file.js'

// bare-fs/bare-path are loaded lazily: space.js (which imports this) is also pulled
// into Node unit tests, where the Bare runtime globals don't exist. The fs paths only
// run in the worker (Bare), so deferring the import keeps the module Node-loadable.
let map = new Map()

async function keysFile() {
  const path = (await import('bare-path')).default
  return path.join(path.dirname(getStoragePath()), 'space-keys.enc')
}

export async function initSpaceKeys() {
  map = new Map()
  const vault = getSpaceKeysVaultKey()
  if (!vault) return
  const fs = (await import('bare-fs')).default
  const file = await keysFile()
  if (!fs.existsSync(file)) return
  const env = JSON.parse(b4a.toString(fs.readFileSync(file)))
  const plain = unwrap(
    { nonce: b4a.from(env.nonce, 'base64'), ciphertext: b4a.from(env.ciphertext, 'base64') },
    vault,
  )
  if (!plain) throw new Error('space-keys: unlock failed')
  const obj = JSON.parse(b4a.toString(plain))
  for (const [spaceId, hex] of Object.entries(obj.entries || {})) {
    map.set(spaceId, b4a.from(hex, 'hex'))
  }
}

export function getContentKey(spaceId) {
  return map.get(spaceId) || null
}

export function hasContentKey(spaceId) {
  return map.has(spaceId)
}

export async function putContentKey(spaceId, sck) {
  map.set(spaceId, b4a.from(sck))
  await persist()
}

async function persist() {
  const vault = getSpaceKeysVaultKey()
  if (!vault) throw new Error('space-keys: identity mode required to persist content keys')
  const entries = {}
  for (const [spaceId, buf] of map) entries[spaceId] = b4a.toString(buf, 'hex')
  const { nonce, ciphertext } = wrap(b4a.from(JSON.stringify({ v: 1, entries })), vault)
  const env = {
    v: 1,
    nonce: b4a.toString(nonce, 'base64'),
    ciphertext: b4a.toString(ciphertext, 'base64'),
  }
  await writeFileAtomic(await keysFile(), b4a.from(JSON.stringify(env)))
}
