// The loose owner side: in-place loose files served through the overlay instance instead of
// copied into the per-space drive. A reserved share id groups loose entries in the per-(owner,space)
// catalog; the bytes stay at the user's original file on disk, resolved per file via the source
// map (not a mount root). The publish core and serve registration are shared with folder shares —
// this module is the loose-specific glue: source map, watch, cap, naming, the `loose` publish
// channel, and cancel / unshare.
//
// Everything that changes what a loose path MEANS — its name, its source link, its tracking,
// whether its entry exists — runs under the per-space lock, and the enqueue happens inside that
// lock so the next admission already sees the name pending. The hash itself runs on the publish
// service's lane, never under the lock.
import path from 'bare-path'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../../../contract/main-requests.js'
import { tombstone as catalogTombstone, getOwnEntry, listOwnShare, listOwnShareForDisplay } from '../../../shares/own-catalog.js'
import { nextFreeName } from '../../../folders/path-keys.js'
import { AppError } from '../../../core/errors.js'
import { CODES } from '../../../contract/errors.js'
import { createKeyedLock } from '../../../core/concurrency.js'
import { getPublishScheduler, registerPublishChannel } from '../../../folders/publish-service.js'
import { OP, PRIORITY } from '../../../folders/work-item.js'
import { fileStatPresent, statFacts } from '../../../folders/disk-presence.js'
import { createLogger } from '../../../core/logger.js'
import { markOwnedSource, getOwnedSourcePath, clearOwnedSource } from '../../files.js'
import { LOOSE_SHARE_ID } from '../../transfer-id.js'
import { publishContent } from './overlay-publish.js'
import { evictIfUnreferenced, makeServable } from './serve-registration.js'
import { makePublishProgress } from './publish-progress.js'
import { looseRelPath, looseDrivePath } from './loose-job.js'

const log = createLogger('loose-publish')

export const MAX_LOOSE_FILES_PER_SPACE = 100

// abs source path -> (spaceId -> relPath). The same file can be shared in several
// spaces, so a watcher event must fan out to every space that holds it.
// test seam
export const looseSources = new Map()

function trackSource(abs, spaceId, relPath) {
  let m = looseSources.get(abs)
  if (!m) looseSources.set(abs, (m = new Map()))
  m.set(spaceId, relPath)
}
function untrackSource(abs, spaceId) {
  const m = looseSources.get(abs)
  if (!m) return
  m.delete(spaceId)
  if (m.size === 0) looseSources.delete(abs)
}
// test seam
export function looseSourceFor(abs, spaceId) {
  return looseSources.get(abs)?.get(spaceId) || null
}

let ipcRef = null
export function initLoosePublish({ ipc }) { ipcRef = ipc }
export function resetLoosePublish() {
  ipcRef = null
  looseSources.clear()
}

const filesUpdated = (spaceId) => ipcRef?.emit('event:files-updated', { spaceId })

function armWatch(spaceId, absPath) {
  ipcRef?.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.LOOSE_FILE_WATCH, args: { spaceId, absPath } })
}
function disarmWatch(spaceId, absPath) {
  ipcRef?.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.LOOSE_FILE_UNWATCH, args: { spaceId, absPath } })
}

const withSpaceLock = createKeyedLock()

// Pick the relPath for a new/changed share under the lock: an already-tracked source keeps its
// name with NO catalog scan (the hot change-event path); a new source does ONE catalog pass
// yielding the taken names (suffix-on-collision) and the count for the cap — including names
// queued but not yet advertised, or two quick adds could both pass the cap.
async function resolveLooseName(spaceId, absPath, fileName) {
  const tracked = looseSourceFor(absPath, spaceId)
  if (tracked) return tracked

  const base = fileName || path.basename(absPath)
  const takenNames = new Set(getPublishScheduler().pendingRelPaths(spaceId, LOOSE_SHARE_ID))
  for await (const e of listOwnShare(spaceId, LOOSE_SHARE_ID)) takenNames.add(e.relPath)

  let relPath = base
  let isNew = true
  if (takenNames.has(base)) {
    const existingSrc = await getOwnedSourcePath(spaceId, looseDrivePath(base))
    if (existingSrc === absPath) isNew = false // same source, untracked (e.g. pre-rehydrate) → reuse name
    else relPath = nextFreeName(base, (c) => takenNames.has(c))
  }
  // Cap applies only to genuinely new entries; an update at the cap is allowed.
  if (isNew && takenNames.size >= MAX_LOOSE_FILES_PER_SPACE) {
    throw new AppError(CODES.LOOSE_FILE_LIMIT, `Limit of ${MAX_LOOSE_FILES_PER_SPACE} shared files per space reached`)
  }
  return relPath
}

// Resolves once the file is published (or its publish was cancelled), so files:add returns when
// the file is really shared.
export async function looseShareFile(spaceId, absPath, fileName) {
  const { relPath, ticket } = await withSpaceLock(spaceId, async () => {
    const relPath = await resolveLooseName(spaceId, absPath, fileName)
    return { relPath, ticket: await admitLoosePublish(spaceId, relPath, absPath, PRIORITY.INTERACTIVE) }
  })
  return await settledWithTail(spaceId, relPath, ticket, absPath)
}

// Under the caller's lock: records the source link (durable BEFORE the hash, so a quit mid-hash
// resumes at boot instead of stranding an "Adding" — and it is what the executor resolves the
// path from), tracks the path, and enqueues, so the next admission already sees the name
// pending. A re-publish re-records the link from the path in hand, healing one lost earlier.
async function admitLoosePublish(spaceId, relPath, absPath, priority) {
  await markOwnedSource(spaceId, looseDrivePath(relPath), absPath)
  trackSource(absPath, spaceId, relPath)
  const { size, mtime } = statFacts(absPath)
  return getPublishScheduler().enqueue({ spaceId, shareId: LOOSE_SHARE_ID, relPath, op: OP.PUBLISH, size, mtime, priority })
}

export async function enqueueLoosePublish(spaceId, relPath, absPath, priority) {
  const ticket = await withSpaceLock(spaceId, () => admitLoosePublish(spaceId, relPath, absPath, priority))
  return await settledWithTail(spaceId, relPath, ticket, absPath)
}

export async function enqueueLooseRetire(spaceId, relPath, priority) {
  const ticket = getPublishScheduler().enqueue({ spaceId, shareId: LOOSE_SHARE_ID, relPath, op: OP.RETIRE, priority })
  return await settledWithTail(spaceId, relPath, ticket, null)
}

// A cancel releases the caller at once while the executor still has to honour the abort and
// revert; the caller resolves only once that tail has exited. A cancel is not a failure (the user
// stopped it); a real error propagates — and so does a publish that found no source link, because
// the file was NOT shared.
async function settledWithTail(spaceId, relPath, ticket, absPath) {
  const outcome = await ticket.settled
  if (outcome.outcome === 'cancelled') {
    await ticket.exited
    await withSpaceLock(spaceId, () => clearOwnedSourceIfUnshared(spaceId, relPath, absPath, { unless: getPublishScheduler().isPending(spaceId, LOOSE_SHARE_ID, relPath) }))
  }
  if (outcome.outcome === 'failed' && outcome.error) throw outcome.error
  if (outcome.result?.outcome === 'unlinked') {
    if (absPath && looseSourceFor(absPath, spaceId) === relPath) untrackSource(absPath, spaceId)
    throw new AppError(CODES.FILE_SOURCE_MISSING, 'Shared file has no source link')
  }
  return outcome
}

export async function looseCancelPublish(spaceId, drivePath) {
  const relPath = looseRelPath(drivePath)
  const { cancelled, exited } = getPublishScheduler().cancelPath(spaceId, LOOSE_SHARE_ID, relPath)
  if (cancelled) await exited
  // Whatever the cancel caught (a running hash, a queued item, or nothing after a restart), a
  // null-hash placeholder left behind is reverted here, so the cancel control always means
  // something. Re-read UNDER the lock and bail if the entry is no longer a placeholder: a resume
  // that completed meanwhile must not have its finished, replicated share torn down. Best-effort
  // (a cancel during close must not surface as an unhandled rejection; boot rehydrate reverts a
  // leftover anyway) and announced only when this revert changed something — a live cancel is
  // announced by the executor's own hook, and a no-op must stay silent.
  let reverted = false
  try {
    await withSpaceLock(spaceId, async () => {
      const entry = await getOwnEntry(spaceId, LOOSE_SHARE_ID, relPath)
      if (!entry || entry.contentHash) return
      const src = await getOwnedSourcePath(spaceId, drivePath)
      await unshareEntry(spaceId, relPath, null, src)
      reverted = true
    })
  } catch (err) {
    log.debug('loose cancel cleanup skipped:', relPath, '-', err.message)
  }
  if (reverted) filesUpdated(spaceId)
}

registerPublishChannel('loose', {
  direct: true,
  // Identity is the recorded absolute path, judged the way the file is opened: a case-only
  // rename on a folding volume or a symlinked source keeps a loose share readable, so it stays.
  present: fileStatPresent,
  async resolve(item) {
    const absPath = await getOwnedSourcePath(item.spaceId, looseDrivePath(item.relPath))
    if (!absPath && item.op === OP.PUBLISH) return { skip: 'unlinked' }
    return { absPath }
  },
  async publish(item, { absPath }, { signal, beat }) {
    const { spaceId, relPath } = item
    // Decoration frames carry spaceId: the bare drive path is unique per space only — without the
    // field two spaces publishing the same-named loose file would mix bytes in the renderer's
    // per-key decoration map.
    const progress = makePublishProgress({ spaceId, shareId: LOOSE_SHARE_ID, relPath, decoKey: looseDrivePath(relPath) })
    try {
      const { changed, contentHash } = await publishContent(spaceId, LOOSE_SHARE_ID, relPath, absPath, {
        signal,
        onAdvertised: (size) => {
          progress.onAdvertised(size)
          filesUpdated(spaceId)
        },
        onProgress: (len) => { progress.onProgress(len); beat?.() },
      })
      return { changed, contentHash }
    } finally {
      progress.done()
    }
  },
  async afterPublish(item, { absPath }, { changed, contentHash }) {
    const { spaceId, relPath } = item
    if (!contentHash) {
      // The source vanished mid-publish. publishContent already reverted its half-advertised
      // entry, so this is a benign abort — the file is simply not shared.
      await withSpaceLock(spaceId, () => clearOwnedSourceIfUnshared(spaceId, relPath, absPath, { unless: item.dirty }))
      log.debug('loose publish aborted — source vanished mid-hash:', absPath)
      filesUpdated(spaceId)
      return
    }
    armWatch(spaceId, absPath)
    // An unchanged healthy entry re-registered at boot advertised nothing new.
    if (changed) filesUpdated(spaceId)
  },
  // publishContent undoes its own half-advertised placeholder on any failure or cancel — and
  // leaves a successfully-published prior version alone — so only a now-dangling source link
  // is dropped here.
  async onPublishFailed(item, { absPath }) {
    await withSpaceLock(item.spaceId, () => clearOwnedSourceIfUnshared(item.spaceId, item.relPath, absPath, { unless: item.dirty }))
    filesUpdated(item.spaceId)
  },
  async retire(item, { absPath }) {
    await withSpaceLock(item.spaceId, async () => {
      const prev = await getOwnEntry(item.spaceId, LOOSE_SHARE_ID, item.relPath)
      await unshareEntry(item.spaceId, item.relPath, prev?.contentHash || null, absPath)
    })
    filesUpdated(item.spaceId)
  },
})

// After a failed, aborted or never-started publish: drop the source link and tracking ONLY if
// nothing advertises the path and no newer admission owns it (`unless`: from the executor's own
// hooks that is a rerun queued behind it, from a caller it is any pending item) — a re-add
// admitted meanwhile has written its own link, and a reverted re-publish keeps its prior
// version's. Called under the lock.
async function clearOwnedSourceIfUnshared(spaceId, relPath, absPath = null, { unless = false } = {}) {
  try {
    if (unless) return
    if (await getOwnEntry(spaceId, LOOSE_SHARE_ID, relPath)) return
    const linked = await getOwnedSourcePath(spaceId, looseDrivePath(relPath))
    if (linked && (!absPath || linked === absPath)) await clearOwnedSource(spaceId, looseDrivePath(relPath))
    if (absPath && looseSourceFor(absPath, spaceId) === relPath) untrackSource(absPath, spaceId)
  } catch (err) {
    log.debug('post-failure source cleanup skipped:', err.message)
  }
}

async function unshareEntry(spaceId, relPath, contentHash, src) {
  await catalogTombstone(spaceId, LOOSE_SHARE_ID, relPath)
  await evictIfUnreferenced({ contentHash, spaceId, shareId: LOOSE_SHARE_ID, relPath })
  await clearOwnedSource(spaceId, looseDrivePath(relPath))
  if (src) { untrackSource(src, spaceId); disarmWatch(spaceId, src) }
}

// A never-hashed entry with no recorded source is an unrecoverable half-publish: revert it so it
// stops showing "Adding" forever.
export async function revertUnhashedEntry(spaceId, relPath) {
  await withSpaceLock(spaceId, () => unshareEntry(spaceId, relPath, null, null))
  filesUpdated(spaceId)
}

// Re-register a healthy, unchanged entry with the serve gate directly, so it is servable at once
// rather than after a lane slot frees.
export async function adoptServable(spaceId, relPath, absPath, { contentHash, size }) {
  await makeServable({ spaceId, shareId: LOOSE_SHARE_ID, relPath, absPath, contentHash, size })
  trackSource(absPath, spaceId, relPath)
  armWatch(spaceId, absPath)
}

// A user action with a synchronous contract: when this resolves the entry is gone. Untracked
// first (a watcher event for the path is ignored from here on), then any item for the path is
// cancelled and its executor waited out, so no tail can advertise after the tombstone. A newer
// admission that lands in that wait is a later intent and wins: the unshare then does nothing.
export async function looseUnshareFile(spaceId, drivePath) {
  const relPath = looseRelPath(drivePath)
  const src = await withSpaceLock(spaceId, async () => {
    const src = await getOwnedSourcePath(spaceId, drivePath)
    if (src) { untrackSource(src, spaceId); disarmWatch(spaceId, src) }
    return src
  })
  const { cancelled, exited } = getPublishScheduler().cancelPath(spaceId, LOOSE_SHARE_ID, relPath)
  if (cancelled) await exited
  await withSpaceLock(spaceId, async () => {
    if (getPublishScheduler().isPending(spaceId, LOOSE_SHARE_ID, relPath)) return
    const prev = await getOwnEntry(spaceId, LOOSE_SHARE_ID, relPath)
    await unshareEntry(spaceId, relPath, prev?.contentHash || null, src)
  })
  filesUpdated(spaceId)
}

export async function looseListOwn(spaceId) {
  // Display path: tolerate a corrupt catalog core as a partial listing (resolveLooseName
  // / sweeps keep listOwnShare and fail loud — they must not act on partial data).
  return await listOwnShareForDisplay(spaceId, LOOSE_SHARE_ID)
}

export async function looseHasOwn(spaceId, drivePath) {
  return !!(await getOwnEntry(spaceId, LOOSE_SHARE_ID, looseRelPath(drivePath)))
}

// Watcher dispatch (one event per (space, path) the file is shared in). Resolves the file's
// assigned name from the reverse map so a change re-publishes under the same name and an unlink
// retires the right entry; an untracked path is ignored. The retire executor re-confirms the
// file is really gone before tombstoning (an atomic save fires an unlink for a path that is
// immediately back).
export async function handleLooseFsEvent({ spaceId, absPath, action }) {
  const relPath = looseSourceFor(absPath, spaceId)
  if (!relPath) return
  if (action === 'unlink') return await enqueueLooseRetire(spaceId, relPath, PRIORITY.INTERACTIVE)
  return await enqueueLoosePublish(spaceId, relPath, absPath, PRIORITY.INTERACTIVE)
}
