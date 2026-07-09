import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { wrap, unwrap } from './identity-envelope.js'

const encFile = (storagePath) => path.join(path.dirname(storagePath), 'identity.enc')

// Resolves the master secret M, wrapped on disk in identity.enc beside the store.
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
  const kek = provider.getKEK()
  if (!kek) throw new Error('identity: no unlock key available')

  if (fs.existsSync(file)) {
    const env = JSON.parse(b4a.toString(fs.readFileSync(file)))
    const M = unwrap({ nonce: b4a.from(env.nonce, 'base64'), ciphertext: b4a.from(env.ciphertext, 'base64') }, kek)
    if (!M) throw new Error('identity unlock failed')
    return M
  }

  const migrating = await hasExistingCores(store)
  const M = migrating ? b4a.from(store.primaryKey) : crypto.randomBytes(32)
  const { nonce, ciphertext } = wrap(M, kek)
  const env = {
    v: 1,
    provider: provider.name,
    nonce: b4a.toString(nonce, 'base64'),
    ciphertext: b4a.toString(ciphertext, 'base64'),
  }
  const fd = fs.openSync(file, 'wx', 0o600)
  fs.writeSync(fd, b4a.from(JSON.stringify(env)))
  fs.fsyncSync(fd)
  fs.closeSync(fd)

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
