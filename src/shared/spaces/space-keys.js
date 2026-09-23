// The SCK vault: per-space content keys (SCK — the key that encrypts a space's catalogs;
// holding it is read access) kept in memory and persisted to space-keys.enc, wrapped by
// a vault key derived from the master secret. Each space holds its current epoch's key and
// the keys of earlier epochs (space-keys-codec.js); the file's plaintext stays in the shape a
// release before epochs reads until an entry leaves epoch 0.
import b4a from 'b4a'
import { wrap, unwrap } from '../core/identity-envelope.js'
import { getSpaceKeysVaultKey, getStoragePath } from '../core/store.js'
import { writeFileAtomic } from '../core/atomic-file.js'
import { Subsystem } from '../core/subsystem.js'
import { decodeVault, encodeVault, setEntry, keyForEpoch } from './space-keys-codec.js'

// bare-fs/bare-path are loaded lazily so importing this module never needs the Bare runtime
// globals; only the vault's fs paths do, and those run in the worker.
let map = new Map()   // spaceId -> { epoch, key, history }

const toHex = (buf) => b4a.toString(buf, 'hex')

async function keysFile() {
  const path = (await import('bare-path')).default
  return path.join(path.dirname(getStoragePath()), 'space-keys.enc')
}

/** @internal production opens the key store through this file's own _open() */
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
  map = decodeVault(JSON.parse(b4a.toString(plain)), b4a.from)
}

// The key for one epoch, current or historical. The space record names the epoch an own core is
// at; a peer catalog's record names the epoch that decrypts it.
export function getContentKeyForEpoch(spaceId, epoch) {
  return keyForEpoch(map.get(spaceId), epoch)
}

// Every SCK we hold, history included, for the leftover scan: a core encrypted under one of them
// reads as garbage without it, and a leave keeps the vault entry — which is exactly when its
// leftovers show up.
export function listContentKeys() {
  const out = []
  for (const { key, history } of map.values()) {
    out.push(key)
    for (const h of history) out.push(h.key)
  }
  return out
}

export async function putContentKey(spaceId, sck, { epoch = 0 } = {}) {
  map.set(spaceId, setEntry(map.get(spaceId), epoch, b4a.from(sck), b4a.equals))
  await persist()
}

async function persist() {
  const vault = getSpaceKeysVaultKey()
  if (!vault) throw new Error('space-keys: identity mode required to persist content keys')
  const plain = encodeVault(map, toHex)
  const { nonce, ciphertext } = wrap(b4a.from(JSON.stringify(plain)), vault)
  const env = {
    v: 1,
    nonce: b4a.toString(nonce, 'base64'),
    ciphertext: b4a.toString(ciphertext, 'base64'),
  }
  await writeFileAtomic(await keysFile(), b4a.from(JSON.stringify(env)))
}

export class SpaceKeysVault extends Subsystem {
  async _open() { await initSpaceKeys() }

  async _close() {
    for (const buf of listContentKeys()) { try { b4a.fill(buf, 0) } catch {} }
    map = new Map()
  }
}
