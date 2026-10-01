// One backup run into a repository: every core's change since the latest snapshot, the space-key vault
// and the app's settings become sealed objects, and a new snapshot names them all. The snapshot is
// written last, so a run that stops part-way — out of time, the drive unplugged — leaves only unnamed
// objects and the previous snapshot still the latest. A run that finds nothing changed writes no
// snapshot. Only the first run of a new folder creates the repository; every later one requires it.
import fs from 'bare-fs'
import path from 'bare-path'
import { AppError } from '../../core/errors.js'
import { CODES } from '../../contract/errors.js'
import { SECRET_FILE, resolveSecretFile } from '../../contract/secret-files.js'
import { listCores } from './inventory.js'
import { openCut, captureCore } from './capture.js'
import { nextCoreEntry, MANIFEST_VERSION } from './manifest.js'
import { openOrInitRepo, openRepo } from './repo.js'

function readVault(storagePath) {
  const file = resolveSecretFile(storagePath, SECRET_FILE.SPACE_KEYS, { join: path.join, dirname: path.dirname, exists: fs.existsSync })
  return fs.existsSync(file) ? fs.readFileSync(file) : null
}

async function putFile(repo, bytes) {
  return bytes ? (await repo.putPart(bytes)).id : null
}

async function captureAll(repo, store, prevByDk, { deadlineAt, now, maxPartBytes }) {
  const cores = await listCores(store)
  const cut = await openCut(store, cores)
  const entries = []
  const stats = { changed: false, parts: 0, bytes: 0 }
  try {
    for (let i = 0; i < cores.length; i++) {
      if (deadlineAt !== null && now() > deadlineAt) throw new AppError(CODES.ECANCELLED, 'backup: ran out of time')
      const prev = prevByDk.get(cores[i].dk) ?? null
      const { now: state, plan, parts } = await captureCore(cut.snaps[i], cores[i], prev, { maxPartBytes })
      if (plan.kind === 'skip') continue
      const ids = []
      if (parts) {
        for await (const part of parts) {
          const { id, written } = await repo.putPart(part)
          ids.push(id)
          stats.parts++
          stats.bytes += written
        }
      }
      if (plan.kind !== 'none') stats.changed = true
      entries.push(nextCoreEntry(prev, state, plan, ids))
    }
  } finally {
    await cut.close()
  }
  return { entries, stats }
}

async function openForRun(target, { wrapKey, repoId, installId, now }) {
  if (!wrapKey) throw new AppError(CODES.IDENTITY_NO_KEK, 'backup: no identity to seal a backup with')
  await target.ready({ create: repoId === null })
  const repo = repoId === null ? await openOrInitRepo(target, { wrapKey, now: now() }) : await openRepo(target, { wrapKey, expectedRepoId: repoId })
  if (await repo.otherWriter(installId, now())) {
    throw new AppError(CODES.BACKUP_OTHER_DEVICE_WRITING, 'backup: another install is writing to this folder')
  }
  // Taken before the capture, so another install starting while this one runs sees it.
  await repo.writeLease(installId, now())
  return repo
}

function sameFiles(previous, files) {
  return previous?.manifest.files?.spaceKeys === files.spaceKeys && previous?.manifest.files?.config === files.config
}

export async function runBackup({
  store, storagePath, target, wrapKey, repoId, installId, appVersion, config = null,
  now = Date.now, deadlineAt = null, maxPartBytes = undefined,
}) {
  const repo = await openForRun(target, { wrapKey, repoId, installId, now })
  const previous = await repo.latestSnapshot()
  const prevByDk = new Map((previous?.manifest.cores ?? []).map((core) => [core.dk, core]))
  const { entries, stats } = await captureAll(repo, store, prevByDk, { deadlineAt, now, maxPartBytes })

  const files = { spaceKeys: await putFile(repo, readVault(storagePath)), config: await putFile(repo, config) }
  const present = new Set(entries.map((entry) => entry.dk))
  const gone = [...prevByDk.keys()].filter((dk) => !present.has(dk))
  const previousName = previous?.name ?? null

  let snapshot = null
  if (!previous || stats.changed || !sameFiles(previous, files) || gone.length > 0) {
    const manifest = { v: MANIFEST_VERSION, createdAt: new Date(now()).toISOString(), appVersion, installId, repoId: repo.repoId, parent: previousName, cores: entries, files, gone }
    snapshot = await repo.writeSnapshot(manifest, { previous: previousName, now: now() })
  }
  await repo.writeLease(installId, now())
  return { repoId: repo.repoId, snapshot, parts: stats.parts, bytes: stats.bytes }
}
