import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import Corestore from 'corestore'
import { resolveMasterSecret } from '../../src/shared/core/identity-resolve.js'
import { osKeychainProvider } from '../../src/shared/core/unlock-providers.js'
import { randomKEK } from '../../src/shared/core/identity-envelope.js'

// MIR-24: the prior MIR-02 migration set M = the RocksDB store seed and overwrote the
// seed in place, but a plain setSeed leaves the old seed (= M) in the WAL/SST until a
// compaction that may never run — so a copied store leaks the master identity. The fix
// makes M independent of the store seed (fresh installs) and best-effort drops the old
// seed blocks (migrating installs). These tests fail on the unfixed tree: the master
// secret appears verbatim in the raw store files.

function tmp (label) {
  const dir = path.join(os.tmpdir(), `identity-seed-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function* walk (dir) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry)
    if (fs.statSync(p).isDirectory()) yield * walk(p)
    else yield p
  }
}

function bytesAppearUnder (root, needle) {
  for (const f of walk(root)) {
    try { if (b4a.includes(fs.readFileSync(f), needle)) return true } catch {}
  }
  return false
}

// REGRESSION (MIR-24): a fresh install's master secret is generated independently and is
// never written as the store seed, so it cannot be recovered from a copy of the store.
// Red on the unfixed tree (M = the auto-generated seed, which lingers in the WAL).
test('REGRESSION (MIR-24): a fresh install never writes the master secret into the store', async (t) => {
  const root = tmp('fresh')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const kekHex = b4a.toString(randomKEK(), 'hex')
  const store = new Corestore(storagePath)
  const M = await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) })
  await store.close()

  t.is(M.length, 32, 'M resolved')
  t.absent(bytesAppearUnder(storagePath, M), 'the master secret never appears in the raw store files')
})

// A migrating (pre-envelope) install must be detected by its pre-existing cores and keep
// its identity (M = the legacy seed; every M-derived key then equals the legacy
// seed-derived key, pinned by identity-keys-pin.test.js), while the on-disk seed is
// replaced so it is no longer the identity. (Raw-byte erasure of the old seed across a
// prior session's WAL/SST is best-effort only — the strong non-recoverability guarantee
// is the fresh-install path above, where M is never the seed.)
test('REGRESSION (MIR-24): a migrating install is detected, preserves identity, and replaces the on-disk seed', async (t) => {
  const root = tmp('migrate')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const KNOWN = b4a.alloc(32, 0xab)
  const legacy = new Corestore(storagePath, { primaryKey: KNOWN, unsafe: true })
  await legacy.ready()
  await legacy.get({ name: 'profile' }).append(b4a.from('legacy'))
  await legacy.close()

  const kekHex = b4a.toString(randomKEK(), 'hex')
  const store = new Corestore(storagePath)
  const M = await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) })
  await store.close()

  t.alike(M, KNOWN, 'detected as migrating: M preserved as the legacy seed — network identity intact')

  const reopened = new Corestore(storagePath)
  await reopened.ready()
  t.unlike(b4a.from(reopened.primaryKey), KNOWN, 'the persisted store seed was replaced — it no longer equals M')
  await reopened.close()
})

// A fresh install re-unlocks the same independent M across a restart (no regression).
test('REGRESSION (MIR-24): a fresh install is identity-stable across restart', async (t) => {
  const root = tmp('stable')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const kekHex = b4a.toString(randomKEK(), 'hex')
  const store = new Corestore(storagePath)
  const M = await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) })
  await store.close()

  const store2 = new Corestore(storagePath)
  const M2 = await resolveMasterSecret({ store: store2, storagePath, provider: osKeychainProvider(kekHex) })
  await store2.close()

  t.alike(M2, M, 'the envelope re-unlocks the same independent M across restart')
})
