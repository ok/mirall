import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { wrap, unwrap, open } from './identity-envelope.js'
import { deriveKeyPair } from './identity-keys.js'
import { writeFileAtomic } from './atomic-file.js'
import { openStore, hasKeyPairCore } from './store.js'
import { AppError } from './errors.js'
import { CODES } from '../contract/errors.js'
import { SECRET_FILE, resolveSecretFile } from '../contract/secret-files.js'

const encFile = (storagePath) => resolveSecretFile(storagePath, SECRET_FILE.IDENTITY, { join: path.join, dirname: path.dirname, exists: fs.existsSync })

// The v2 header is authenticated, so its version and provider cannot be changed without failing the unlock.
const identityAad = (sealed) => b4a.from(`mirall-identity|${sealed.v}|${sealed.provider}`)

const unreadable = (why) => new AppError(CODES.IDENTITY_UNLOCK_FAILED, `identity: ${why}`)

// An envelope that cannot even be parsed locks the identity like one the key cannot open: either way
// the user resolves it with a recovery key or by starting fresh, never by a worker that crashes.
function readEnvelope(file) {
  let sealed
  try {
    sealed = JSON.parse(b4a.toString(fs.readFileSync(file)))
  } catch {
    throw unreadable('the envelope is unreadable')
  }
  if (!sealed || typeof sealed !== 'object' || typeof sealed.nonce !== 'string' || typeof sealed.ciphertext !== 'string') {
    throw unreadable('the envelope is malformed')
  }
  return sealed
}

function unsealMasterSecret(sealed, kek) {
  const box = { nonce: b4a.from(sealed.nonce, 'base64'), ciphertext: b4a.from(sealed.ciphertext, 'base64') }
  if (sealed.v === 1) return unwrap(box, kek)
  if (sealed.v === 2) return open(box, kek, identityAad(sealed))
  throw unreadable(`unsupported envelope version ${sealed.v}`)
}

function envelopeBytes(masterSecret, kek, providerName) {
  const { nonce, ciphertext } = wrap(masterSecret, kek)
  return b4a.from(JSON.stringify({
    v: 1,
    provider: providerName,
    nonce: b4a.toString(nonce, 'base64'),
    ciphertext: b4a.toString(ciphertext, 'base64'),
  }))
}

// Resolves the master secret M, wrapped on disk in identity.enc (see contract/secret-files.js for where).
// Once the envelope exists, M lives only there and every writable core derives from
// it (store.js), so the RocksDB seed never needs to equal the identity.
//
// M must never linger as the store's persisted RocksDB seed: setSeed is a plain
// RocksDB Put, so a replaced value survives in superseded SST/WAL blocks until a
// compaction that may never run — a copied store directory would leak the identity.
// The no-envelope case therefore splits:
//   - fresh install  → M is an independent random value; the store keeps its own
//     random seed (identity-irrelevant), so there is nothing to scrub.
//   - migrating install (a store written before the envelope existed, cores already
//     derived from the seed) → M must stay that seed to preserve identity, then
//     replace + best-effort drop the old seed blocks.
// "Migrating" is detected by whether identity-bearing cores already exist — the exact
// condition under which the seed equals the identity. (getSeed() can't distinguish:
// the Corestore constructor auto-readies and persists a random seed for fresh installs.)
// The envelope is wrapped + fsynced BEFORE any destructive seed mutation so a crash
// never loses identity.
export async function resolveMasterSecret({ store, storagePath, provider }) {
  await store.ready()
  const file = encFile(storagePath)
  // The provider is checked before it is asked for a key: one that must wait for input would
  // otherwise wait for a key that cannot open this envelope.
  const sealed = fs.existsSync(file) ? readEnvelope(file) : null
  if (sealed && sealed.provider !== provider.name) {
    throw new AppError(CODES.IDENTITY_PROVIDER_MISMATCH, `identity: sealed by provider "${sealed.provider}", not "${provider.name}"`)
  }
  const kek = await provider.getKEK()
  if (!kek) throw new AppError(CODES.IDENTITY_NO_KEK, 'identity: no unlock key available')

  if (sealed) {
    const M = unsealMasterSecret(sealed, kek)
    if (!M) throw new AppError(CODES.IDENTITY_UNLOCK_FAILED, 'identity unlock failed')
    return M
  }

  const migrating = await hasExistingCores(store)
  const M = migrating ? b4a.from(store.primaryKey) : crypto.randomBytes(32)
  await writeFileAtomic(file, envelopeBytes(M, kek, provider.name))

  if (migrating) {
    await store.storage.setSeed(crypto.randomBytes(32), { overwrite: true })
    await dropOldSeedBlocks(store)
  }
  return M
}

// Identity-bearing cores from a prior run mean the persisted seed is the identity and
// must be preserved as M. A fresh store has none (this runs before any core is created).
async function hasExistingCores(store) {
  for await (const _dk of store.storage.createDiscoveryKeyStream()) return true
  return false
}

// Best-effort: after replacing the seed, force RocksDB to rewrite its files so the old
// seed (= M) no longer lingers in superseded SST/WAL blocks. The strong guarantee is the
// fresh-install path above (M was never the seed); this only shrinks the migrating window.
async function dropOldSeedBlocks(store) {
  try {
    const db = store.storage.db
    if (typeof db?.flush === 'function') await db.flush()
    if (typeof db?.compactRange === 'function') await db.compactRange(null, null)
  } catch {}
}

// Replaces the envelope with M sealed under this machine's key: how a recovery key's identity is
// adopted. Atomic, so a crash leaves the old envelope or the new one, never neither.
export async function sealMasterSecret({ storagePath, provider, masterSecret }) {
  const kek = await provider.getKEK()
  if (!kek) throw new AppError(CODES.IDENTITY_NO_KEK, 'identity: no unlock key available')
  await writeFileAtomic(encFile(storagePath), envelopeBytes(masterSecret, kek, provider.name))
}

// Whether a store already holds data, and whether that data is M's: the profile core is derived from
// M, so it is on disk exactly when the store was written under this identity.
export async function storeHoldsIdentity(store, masterSecret) {
  await store.ready()
  return {
    hasCores: await hasExistingCores(store),
    holdsProfile: await hasKeyPairCore(store, deriveKeyPair(masterSecret, 'profile').publicKey),
  }
}

// The same question for the store a locked worker's failed boot closed, opened the one way stores
// open (it waits out a lock the previous close is still releasing).
export async function storageHoldsIdentity(storagePath, masterSecret) {
  const store = await openStore(storagePath)
  try {
    return await storeHoldsIdentity(store, masterSecret)
  } finally {
    await store.close()
  }
}
