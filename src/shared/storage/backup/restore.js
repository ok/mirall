// Reading a backup back: the snapshots a recovery key can open, and one of them rebuilt into a staging
// store beside the live one. Every core is applied from its parts and then checked against the length
// and tree hash the snapshot recorded, so a backup that does not rebuild exactly is refused before
// anything replaces the live data. The swap itself happens before the next store opens
// (identity-adopt.js).
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import Corestore from 'corestore'
import { AppError } from '../../core/errors.js'
import { CODES } from '../../contract/errors.js'
import { SECRET_FILE } from '../../contract/secret-files.js'
import { deriveBackupWrapKey } from '../../core/identity-keys.js'
import { FolderTarget } from './folder-target.js'
import { openRepo } from './repo.js'
import { decodePart } from './segment-codec.js'
import { applyRecord, rootTreeHash } from './core-proofs.js'
import { CORE_ROLE } from './inventory.js'

const HELD_ROLES = new Set([CORE_ROLE.PROFILE, CORE_ROLE.OWN_CATALOG])

export async function openBackup(folder, masterSecret) {
  const target = new FolderTarget(folder)
  await target.ready()
  return openRepo(target, { wrapKey: deriveBackupWrapKey(masterSecret) })
}

export async function listRestorable(repo) {
  const out = []
  for (const name of await repo.listSnapshots()) {
    const manifest = await repo.readSnapshot(name)
    if (!manifest) continue
    out.push({ name, createdAt: manifest.createdAt, suspect: manifest.suspect?.reasons ?? null, spaces: manifest.vitals?.spaces ?? null, appVersion: manifest.appVersion ?? null })
  }
  return out
}

async function rebuildCore(repo, store, entry) {
  const core = store.get({ key: b4a.from(entry.key, 'hex') })
  try {
    await core.ready()
    for (const segment of entry.segments) {
      for (const id of segment.parts) {
        for (const record of decodePart(await repo.readPart(id)).records) await applyRecord(core, record)
      }
    }
    if (core.length !== entry.length || (await rootTreeHash(core, entry.length)) !== entry.treeHash) {
      throw new AppError(CODES.BACKUP_CORRUPT, `backup: ${entry.role} ${entry.dk.slice(0, 8)} does not rebuild to its recorded state`)
    }
  } finally {
    await core.close()
  }
}

// The snapshot rebuilt into `staging` (emptied first), the bee names to hold until peers confirm them,
// and the settings it carried.
export async function stageRestore(repo, snapshot, staging) {
  const manifest = await repo.readSnapshot(snapshot)
  if (!manifest) throw new AppError(CODES.BACKUP_CORRUPT, 'backup: that snapshot cannot be read')
  fs.rmSync(staging, { recursive: true, force: true })
  const store = new Corestore(staging)
  try {
    await store.ready()
    for (const entry of manifest.cores) await rebuildCore(repo, store, entry)
  } finally {
    await store.close()
  }
  if (manifest.files?.spaceKeys) fs.writeFileSync(path.join(staging, SECRET_FILE.SPACE_KEYS), await repo.readPart(manifest.files.spaceKeys), { mode: 0o600 })
  const hold = manifest.cores.filter((entry) => HELD_ROLES.has(entry.role) && entry.name).map((entry) => entry.name)
  const settings = manifest.files?.config ? b4a.toString(await repo.readPart(manifest.files.config)) : null
  return { hold, settings }
}
