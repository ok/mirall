// One backup run into a repository: every core's change since the latest snapshot, the space-key vault
// and the app's settings become sealed objects, and a new snapshot names them all. The snapshot is
// written last, so a run that stops part-way — out of time, the drive unplugged — leaves only unnamed
// objects and the previous snapshot still the latest. Every core is planned before anything is
// written: a run whose changes are bookkeeping alone (snapshot-rules.js) uploads nothing and writes no
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
import { storeVitals, lossBaselineManifest, lossVerdict, explainedLoss, adjustBaseline } from './loss-check.js'
import { snapshotDue, nextDepartures } from './snapshot-rules.js'
import { listSpaces } from '../../spaces/space.js'
import { removedSpaces as readRemovedSpaces } from '../removal-evidence.js'

function readVault(storagePath) {
  const file = resolveSecretFile(storagePath, SECRET_FILE.SPACE_KEYS, { join: path.join, dirname: path.dirname, exists: fs.existsSync })
  return fs.existsSync(file) ? fs.readFileSync(file) : null
}

async function putFile(repo, bytes) {
  return bytes ? (await repo.putPart(bytes)).id : null
}

const outOfTime = (stopAt, now) => {
  const at = stopAt()
  return at !== null && now() > at
}

async function planAll(cut, cores, prevByDk, { stopAt, now, maxPartBytes }) {
  const captures = []
  for (let i = 0; i < cores.length; i++) {
    if (outOfTime(stopAt, now)) throw new AppError(CODES.ECANCELLED, 'backup: ran out of time')
    const prev = prevByDk.get(cores[i].dk) ?? null
    const capture = await captureCore(cut.snaps[i], cores[i], prev, { maxPartBytes })
    if (capture.plan.kind !== 'skip') captures.push({ prev, ...capture })
  }
  return captures
}

async function uploadAll(repo, captures, { stopAt, now }) {
  const entries = []
  const stats = { parts: 0, bytes: 0 }
  for (const { prev, now: state, plan, parts } of captures) {
    if (outOfTime(stopAt, now)) throw new AppError(CODES.ECANCELLED, 'backup: ran out of time')
    const ids = []
    if (parts) {
      for await (const part of parts) {
        const { id, written } = await repo.putPart(part)
        ids.push(id)
        stats.parts++
        stats.bytes += written
      }
    }
    entries.push(nextCoreEntry(prev, state, plan, ids))
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

function summary(snapshot) {
  if (!snapshot) return null
  const { createdAt, suspect = null, explained = null } = snapshot.manifest
  return { name: snapshot.name, createdAt, suspect, explained }
}

// The new snapshot, flagged when its vitals look like a loss against the last unflagged one, once
// what removals through the leave and join flows explain is taken out of that one (explainedLoss). A
// removal recorded before the baseline still counts: a left space's cores can outlive the snapshot
// that saw it go, until the leftover sweep.
async function lossCheck(repo, previous, current, { now, removedSpaces }) {
  const lastUnflagged = previous && !previous.manifest.suspect ? previous : await repo.latestUnflagged()
  const baseline = lossBaselineManifest(lastUnflagged?.manifest ?? null, previous?.manifest ?? null, now())
  if (!baseline?.vitals) return { suspect: null, explained: null }
  const explained = explainedLoss(baseline, current, await removedSpaces())
  const suspect = lossVerdict(adjustBaseline(baseline.vitals, explained), current.vitals)
  return { suspect, explained: explained.spaces || explained.cores || explained.ownLength ? explained : null }
}

async function writeNext(repo, previous, body, options) {
  const { now } = options
  const spaces = (await listSpaces()).map((space) => ({ id: space.spaceId, name: space.name }))
  const vitals = storeVitals(body.cores, spaces.length)
  const { suspect, explained } = await lossCheck(repo, previous, { cores: body.cores, spaces, vitals }, options)
  const manifest = { v: MANIFEST_VERSION, createdAt: new Date(now()).toISOString(), repoId: repo.repoId, parent: previous?.name ?? null, ...body, vitals, suspect, explained, spaces, departures: nextDepartures(previous, spaces, now()) }
  const name = await repo.writeSnapshot(manifest, { previous: previous?.name ?? null, now: now() })
  return { name, manifest }
}

// `stopAt` is read as the run goes, so a caller can bring the end forward while it runs; past it, the
// run stops before writing a snapshot. The result names the latest snapshot whether or not this run
// wrote one.
export async function runBackup({
  store, storagePath, target, wrapKey, repoId, installId, appVersion, config = null,
  now = Date.now, stopAt = () => null, maxPartBytes = undefined, removedSpaces = readRemovedSpaces,
}) {
  const repo = await openForRun(target, { wrapKey, repoId, installId, now })
  const previous = await repo.latestSnapshot()
  const prevByDk = new Map((previous?.manifest.cores ?? []).map((core) => [core.dk, core]))
  const files = { spaceKeys: await putFile(repo, readVault(storagePath)), config: await putFile(repo, config) }

  const cores = await listCores(store)
  const cut = await openCut(store, cores)
  let written = null
  let stats = { parts: 0, bytes: 0 }
  try {
    const captures = await planAll(cut, cores, prevByDk, { stopAt, now, maxPartBytes })
    const present = new Set(captures.map((capture) => capture.now.dk))
    const gone = [...prevByDk.keys()].filter((dk) => !present.has(dk))
    const changed = captures.filter((capture) => capture.plan.kind !== 'none').map((capture) => capture.now)
    if (snapshotDue({ first: !previous, filesChanged: !sameFiles(previous, files), changed, gone: gone.map((dk) => prevByDk.get(dk)) })) {
      const uploaded = await uploadAll(repo, captures, { stopAt, now })
      stats = uploaded.stats
      if (outOfTime(stopAt, now)) throw new AppError(CODES.ECANCELLED, 'backup: ran out of time')
      written = await writeNext(repo, previous, { appVersion, installId, cores: uploaded.entries, files, gone }, { now, removedSpaces })
    }
  } finally {
    await cut.close()
  }
  await repo.writeLease(installId, now())
  return { repoId: repo.repoId, snapshot: written?.name ?? null, latest: summary(written ?? previous), parts: stats.parts, bytes: stats.bytes }
}
