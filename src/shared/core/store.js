// The factory for everything in the app's single Corestore: every bee, drive, and core
// is opened here. When the master secret M is set, every writable core's keyPair and
// every local encryption key derive from it (identity-keys.js), so the on-disk seed
// carries no identity. Also hosts the core-name registry + inventory diagnostics used
// to pin down which core a storage corruption belongs to.
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import { deriveKeyPair, deriveDriveKeyPair, deriveContentKey } from './identity-keys.js'
import { createLogger } from './logger.js'

const log = createLogger('store')

let store
let storagePath
let masterSecret = null
let metadataKey = null
let overlayIndexKey = null

export function initStore(path) {
  if (!path) throw new Error('initStore: storage path is required')
  storagePath = path
  store = new Corestore(path)
  return store
}

// When set, identity cores open from an explicit keyPair derived from M instead of
// the persisted seed (so the scrubbed on-disk seed yields no signing key). null ⇒
// plain name-based seed derivation (tests / the MIRALL_INSECURE_IDENTITY escape hatch).
export function setMasterSecret(buf) {
  masterSecret = buf
  metadataKey = null
  overlayIndexKey = null
}

export function hasMasterSecret() {
  return masterSecret !== null
}

export function getStore() {
  return store
}

export function getStoragePath() {
  return storagePath
}

// SCK for a space I create — deterministic, re-derivable from M, so it needs no storage.
export function deriveSpaceContentKey(spaceId) {
  return masterSecret ? deriveContentKey(masterSecret, 'space-content/' + spaceId) : null
}

// Key that wraps space-keys.enc (the joined-SCK vault); also M-derived.
export function getSpaceKeysVaultKey() {
  return masterSecret ? deriveContentKey(masterSecret, 'space-keys-vault') : null
}

// discoveryKey(hex) → friendly name, kept so the corruption inventory
// (diagnoseStoreCores) can identify our own cores. corestore drops the alias from the
// in-memory core, and a keyPair's discovery key is the hash of its derived manifest (not
// of the public key), so we record the real discoveryKey once the core is ready. The
// .then is attached before the caller awaits the bee/drive, so the name is registered by
// the time anything reads the inventory. Best effort: never throws, never blocks open.
const nameByDk = new Map()
function rememberCoreName(core, name) {
  try {
    core.ready().then(
      () => { try { nameByDk.set(b4a.toString(core.discoveryKey, 'hex'), name) } catch {} },
      () => {}
    )
  } catch { /* a core without ready() — skip naming */ }
}

export function createBee(name, { encryptionKey = null } = {}) {
  const core = masterSecret
    ? store.get({ keyPair: deriveKeyPair(masterSecret, name), ...(encryptionKey ? { encryptionKey } : {}) })
    : store.get({ name, ...(encryptionKey ? { encryptionKey } : {}) })
  rememberCoreName(core, name)
  return new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  })
}

// Local-only metadata bees, encrypted at rest under an M-derived key. Never
// replicated, so an M-only key is safe; profile + share catalogs stay on
// createBee because peers must read them.
export const LOCAL_BEE_NAMES = [
  'spaces-meta', 'downloads-meta', 'pending-transfers',
  'reclaim-meta', 'mounts-meta', 'app-migrations',
  'audit-log',
]

function metadataBeeKey() {
  if (!masterSecret) return null
  if (metadataKey === null) metadataKey = deriveContentKey(masterSecret, 'metadata-bees')
  return metadataKey
}

// One M-derived key for the overlay's local index cores (file-index, index-meta,
// sync-feed). The overlay is global across spaces, so there's no per-space SCK to
// use; an M-only key is correct AND safe — the cores are local, and the per-block
// key mixes each core's public key, so one key never collides across them.
export function overlayIndexEncryptionKey() {
  if (!masterSecret) return null
  if (overlayIndexKey === null) overlayIndexKey = deriveContentKey(masterSecret, 'overlay-index')
  return overlayIndexKey
}

// The '/v2' keyPair opens a fresh core, so an existing plaintext bee is never
// reopened with an encryptionKey (which would decrypt cleartext as ciphertext);
// a one-time migration copies any plaintext core into it. Without M (insecure /
// test mode) this is plain createBee behaviour. The registration assert makes a
// forgotten LOCAL_BEE_NAMES entry fail loudly instead of silently skipping
// migration + the leftover wanted-set.
export function localBeeCore(name) {
  if (!LOCAL_BEE_NAMES.includes(name)) throw new Error('createLocalBee: unregistered local bee "' + name + '"')
  const core = !masterSecret
    ? store.get({ name })
    : store.get({ keyPair: deriveKeyPair(masterSecret, name + '/v2'), encryptionKey: metadataBeeKey() })
  rememberCoreName(core, name)
  return core
}

export function createLocalBee(name) {
  return new Hyperbee(localBeeCore(name), { keyEncoding: 'utf-8', valueEncoding: 'json' })
}

export function createDrive(name, { encryptionKey = null } = {}) {
  if (!masterSecret) {
    const ns = store.namespace(name)
    return encryptionKey ? new Hyperdrive(ns, { encryptionKey }) : new Hyperdrive(ns)
  }
  // The _db path bypasses Hyperdrive's makeBee, which is the only place an encryptionKey
  // reaches the metadata core. So thread the SCK to the db core's store.get AND the
  // Hyperdrive ctor (blobs) — passing one alone leaves file paths or contents in plaintext.
  const core = store.get({
    keyPair: deriveDriveKeyPair(masterSecret, name),
    exclusive: true,
    ...(encryptionKey ? { encryptionKey } : {}),
  })
  rememberCoreName(core, name)
  const db = new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
    metadata: { contentFeed: null },
  })
  const drive = encryptionKey
    ? new Hyperdrive(store, { _db: db, encryptionKey })
    : new Hyperdrive(store, { _db: db })
  // Hyperdrive opens the blobs core by key (no alias), so name it via the 'blobs' event
  // — for an OWN drive that's the likeliest large-file "Expected tree node" site, and we
  // want diagnoseStoreCores to pin it, not just the metadata core. Fires during ready()
  // for writable drives; a harmless no-op listener if blobs never open.
  drive.on('blobs', (blobs) => rememberCoreName(blobs.core, name + ':blobs'))
  return drive
}

// Classify a replication/read error as an on-disk merkle-tree inconsistency — the
// bitfield/length claims blocks the tree-node store can't back ("Expected tree node N
// from storage, got (nil)"). Shared by the swarm socket-error handler (dump the core
// inventory) and the catalog DISPLAY read (degrade to a partial listing). Any other
// error is NOT this and must propagate.
export function isStorageInconsistency(err) {
  const msg = err?.message || ''
  return msg.includes('from storage, got (nil)') || /Expected tree node \d+ from storage/.test(msg)
}

// Snapshot every open core's identity — name (resolved from the nameByDk registry for
// cores we opened, e.g. 'space-catalog-…'; '(opened by key)' for peer cores we replicate
// by key), discovery key, and length. corestore's `cores` iterates the internal core
// objects, from which we read discoveryKey + state.length without opening sessions or
// reading blocks. Best effort and side-effect free: never throws. Returns [] when the
// store isn't initialised.
export function collectStoreCoreInfo() {
  if (!store) return []
  const out = []
  try {
    for (const core of [...store.cores]) {
      let dkFull = null
      let dk = '?'
      let len = '?'
      try { dkFull = b4a.toString(core.discoveryKey, 'hex'); dk = dkFull.slice(0, 16) } catch {}
      try { len = core.state?.length ?? '?' } catch {}
      out.push({ name: (dkFull && nameByDk.get(dkFull)) || '(opened by key)', dk, len })
    }
  } catch { /* best effort */ }
  return out
}

// Diagnostic dump of the open-core inventory. A replication proof failure
// ("INVALID_OPERATION: Expected tree node N from storage, got (nil)") surfaces on the
// swarm socket as a peer error that names the PEER, not the core that failed to produce
// the proof — so on its own the log can't say WHICH core is corrupt. This names them.
export function diagnoseStoreCores(reason) {
  const cores = collectStoreCoreInfo()
  log.error(`store core inventory (${reason}) — ${cores.length} open core(s):`)
  for (const c of cores) log.error(`  ${c.name} dk=${c.dk}… len=${c.len}`)
}
