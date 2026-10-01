// A backup repository on a target: a header holding the wrapped repository key, write-once sealed
// objects named by a keyed hash, one sealed manifest per snapshot, and a lease per writing install.
// Opening checks, in order, that a backup is there at all (an unmounted share has none), that it is
// the one this device set up, and that this identity can unwrap its key. Snapshot names start with a
// sequence number one past the latest, so their order never depends on the clock.
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { AppError } from '../../core/errors.js'
import { CODES } from '../../contract/errors.js'
import { newRepoKey, wrapRepoKey, unwrapRepoKey, repoSubkeys, objectId, sealBlob, openBlob } from './repo-crypto.js'
import { validateManifest } from './manifest.js'

const HEADER = 'mirall-backup.json'
const FORMAT = 'mirall-backup'
const HEADER_VERSION = 1
const OBJECTS = 'objects'
const SNAPSHOTS = 'snapshots'
const LEASES = 'leases'

// Another install that wrote within this window is still using the folder.
export const LEASE_FRESH_MS = 24 * 60 * 60 * 1000

const objectPath = (id) => `${OBJECTS}/${id.slice(0, 2)}/${id}`
const objectAd = (id) => `mb-obj|1|${id}`
const snapshotAd = (name) => `mb-snap|1|${name}`
const SNAPSHOT_NAME = /^\d{8}-\d{8}T\d{6}Z-[0-9a-f]{8}$/
const PREFIX = /^[0-9a-f]{2}$/
const OBJECT_ID = /^[0-9a-f]{64}$/

function snapshotName(previous, now) {
  const seq = previous ? Number(previous.slice(0, 8)) + 1 : 1
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${String(seq).padStart(8, '0')}-${stamp}-${b4a.toString(crypto.randomBytes(4), 'hex')}`
}

function parseHeader(bytes) {
  try {
    const header = JSON.parse(b4a.toString(bytes))
    if (header?.format === FORMAT && header.v === HEADER_VERSION && typeof header.repoId === 'string') return header
  } catch {}
  return null
}

// What a folder shows without its key: whether a backup is there, and when the newest snapshot was
// written — snapshot names carry their time in the clear, their content never.
export async function peekRepo(target) {
  if (!(await target.has(HEADER))) return { backup: false, lastBackupAt: null }
  const newest = (await target.list(SNAPSHOTS)).filter((name) => SNAPSHOT_NAME.test(name)).sort().pop()
  const stamp = newest?.slice(9, 25)
  const lastBackupAt = stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z` : null
  return { backup: true, lastBackupAt }
}

// A folder's repository for a device that has none remembered: the one already there when this
// identity can open it (a first run that stopped part-way, a reinstall pointed at its own backup),
// otherwise a new one.
export async function openOrInitRepo(target, { wrapKey, now = Date.now() }) {
  if (await target.has(HEADER)) return openRepo(target, { wrapKey })
  const repoId = b4a.toString(crypto.randomBytes(16), 'hex')
  const repoKey = newRepoKey()
  const header = { format: FORMAT, v: HEADER_VERSION, repoId, createdAt: new Date(now).toISOString(), wrap: wrapRepoKey(repoKey, wrapKey, repoId) }
  if ((await target.putOnce(HEADER, b4a.from(JSON.stringify(header)))) === 'exists') return openRepo(target, { wrapKey })
  return new Repository(target, repoId, repoSubkeys(repoKey))
}

export async function openRepo(target, { wrapKey, expectedRepoId = null }) {
  if (!(await target.has(HEADER))) throw new AppError(CODES.BACKUP_TARGET_OFFLINE, 'backup: no backup in this folder')
  const header = parseHeader(await target.read(HEADER))
  if (!header) throw new AppError(CODES.BACKUP_CORRUPT, 'backup: the header is unreadable')
  if (expectedRepoId && header.repoId !== expectedRepoId) throw new AppError(CODES.BACKUP_FOREIGN_REPO, 'backup: this folder holds another backup')
  const repoKey = unwrapRepoKey(header.wrap, wrapKey, header.repoId)
  if (!repoKey) throw new AppError(CODES.BACKUP_FOREIGN_IDENTITY, 'backup: made by another identity')
  return new Repository(target, header.repoId, repoSubkeys(repoKey))
}

export class Repository {
  constructor(target, repoId, keys) {
    this.target = target
    this.repoId = repoId
    this.keys = keys
  }

  // Stored once: an object already there under its id is the same plaintext.
  async putPart(plain) {
    const id = objectId(this.keys, plain)
    const outcome = await this.target.putOnce(objectPath(id), sealBlob(this.keys.object, plain, objectAd(id)))
    return { id, written: outcome === 'written' ? plain.byteLength : 0 }
  }

  // A missing object in a reachable backup is damage; with the header gone too, the folder is.
  async readPart(id) {
    if (!(await this.target.has(objectPath(id)))) {
      if (!(await this.target.has(HEADER))) throw new AppError(CODES.BACKUP_TARGET_OFFLINE, 'backup: the backup folder is gone')
      throw new AppError(CODES.BACKUP_CORRUPT, `backup: object ${id.slice(0, 8)} is missing`)
    }
    const sealed = await this.target.read(objectPath(id))
    const plain = openBlob(this.keys.object, sealed, objectAd(id))
    if (!plain || objectId(this.keys, plain) !== id) throw new AppError(CODES.BACKUP_CORRUPT, `backup: object ${id.slice(0, 8)} does not open`)
    return plain
  }

  async writeSnapshot(manifest, { previous = null, now = Date.now() } = {}) {
    const name = snapshotName(previous, now)
    const sealed = sealBlob(this.keys.snapshot, b4a.from(JSON.stringify({ ...manifest, name })), snapshotAd(name))
    await this.target.putOnce(`${SNAPSHOTS}/${name}`, sealed)
    return name
  }

  async listSnapshots() {
    return (await this.target.list(SNAPSHOTS)).filter((name) => SNAPSHOT_NAME.test(name)).sort().reverse()
  }

  // The manifest, or null for a name this repository never writes, or one that does not open or does not
  // describe a restorable snapshot.
  async readSnapshot(name) {
    if (!SNAPSHOT_NAME.test(name) || !(await this.target.has(`${SNAPSHOTS}/${name}`))) return null
    const plain = openBlob(this.keys.snapshot, await this.target.read(`${SNAPSHOTS}/${name}`), snapshotAd(name))
    if (!plain) return null
    let manifest
    try {
      manifest = JSON.parse(b4a.toString(plain))
    } catch {
      return null
    }
    return manifest?.name === name && validateManifest(manifest) === null ? manifest : null
  }

  async latestSnapshot() {
    for (const name of await this.listSnapshots()) {
      const manifest = await this.readSnapshot(name)
      if (manifest) return { name, manifest }
    }
    return null
  }

  // The newest snapshot that was not flagged as a loss.
  async latestUnflagged() {
    for (const name of await this.listSnapshots()) {
      const manifest = await this.readSnapshot(name)
      if (manifest && !manifest.suspect) return { name, manifest }
    }
    return null
  }

  deleteSnapshot(name) {
    return this.target.remove(`${SNAPSHOTS}/${name}`)
  }

  // Only names this repository writes: a folder browser or a share leaves its own files around
  // (.DS_Store, ._ metadata), and those are neither objects nor folders of them.
  async objectIds() {
    const ids = []
    for (const prefix of (await this.target.list(OBJECTS)).filter((name) => PREFIX.test(name))) {
      for (const id of await this.target.list(`${OBJECTS}/${prefix}`)) if (OBJECT_ID.test(id) && id.startsWith(prefix)) ids.push(id)
    }
    return ids
  }

  objectMtime(id) {
    return this.target.mtime(objectPath(id))
  }

  deleteObject(id) {
    return this.target.remove(objectPath(id))
  }

  async otherWriter(installId, now = Date.now()) {
    for (const file of await this.target.list(LEASES)) {
      if (file === `${installId}.json`) continue
      let lease
      try {
        lease = JSON.parse(b4a.toString(await this.target.read(`${LEASES}/${file}`)))
      } catch {
        continue
      }
      if (typeof lease?.lastRunAt === 'number' && now - lease.lastRunAt < LEASE_FRESH_MS) return lease
    }
    return null
  }

  // A restore is the old installation's end: its lease would otherwise keep the restored device from
  // backing up into the same folder for a day.
  async clearLeases() {
    for (const file of await this.target.list(LEASES)) await this.target.remove(`${LEASES}/${file}`)
  }

  async writeLease(installId, now = Date.now()) {
    await this.target.replaceOwn(`${LEASES}/${installId}.json`, b4a.from(JSON.stringify({ installId, lastRunAt: now })))
  }
}
