// The space:leave flow, lifted out of the worker entrypoint. The handler is a 200-line, 14-phase
// state machine reaching ~35 callees across ~10 modules; living in the file whose job is wiring is
// why the reusable half of this flow (spaces/leave-flow.js, which boot's interrupted-leave pass
// runs) was written separately and drifted from it. Both now share the step order.
import { record } from '../../shared/audit/audit-log.js'
import { unmountForeignFolder } from '../../shared/folders/foreign-folders.js'
import { deleteOwnedMount, listForeignMounts, listOwnedMounts } from '../../shared/folders/mount-store.js'
import { stopOwnedFolder } from '../../shared/folders/owned-folders.js'
import { stopPublishingForSpace } from '../../shared/folders/publish-service.js'
import { purgeOwnCatalog } from '../../shared/shares/share-catalog.js'
import { readOwnShares, tombstoneShare } from '../../shared/shares/shares.js'
import { closeMemberView } from '../../shared/spaces/member-registry.js'
import { clearOwnMembership, getLocalPublicKeyHex } from '../../shared/spaces/profile.js'
import { forgetSpaceRecord, getSpace, markSpaceLeavingDurable, persistPendingLeave, purgeSpace, purgeSpaceDrive } from '../../shared/spaces/space.js'
import { runLeaveTeardown } from '../../shared/spaces/leave-flow.js'
import { forgetUnreferencedPeerCores } from '../../shared/storage/leftover.js'
import { getSpaceCacheBytes } from '../../shared/storage/storage.js'
import { overlayCancelSpace } from '../../shared/transfer/backends/overlay/overlay-backend.js'
import { bumpServeEpoch, revokeServesForSpace } from '../../shared/transfer/backends/overlay/overlay-instance.js'
import { cleanupDownloadHistory } from '../../shared/transfer/files.js'
import { looseCancelSpace } from '../../shared/transfer/loose-overlay.js'
import { clearPendingForSpace } from '../../shared/transfer/pending-transfers.js'
import {
  awaitLeaveAcks, cleanupSpaceDrives, compactStore, hasPendingCancel, hasPendingLeave, isSpaceLeaving,
  joinPendingCancelTopic, joinPendingLeaveTopic, leaveSpaceTopic, markSpaceLeaving, registerPendingCancel,
  registerPendingLeave, sendLeaveFrameToConnectedPeers, sendPendingCancelToConnected, takeLeaveAckedKeys,
  unmarkSpaceLeaving,
} from '../../shared/transfer/swarm.js'

export function registerSpaceLeave(ipc, { log, mounts, selfActor, spaceRef, discardPendingSpace, dropSpaceDownloadRoot }) {
  // Persist a pending-leave marker BEFORE the record purge erases the topic, so the swarm can
  // re-announce the leave to members who were offline at leave time (and boot re-joins the topic)
  // until they provably apply it — without this they keep us as a ghost member forever. Arm iff
  // some OTHER member did NOT ack: this excludes a solo space (no members → nobody to tell → no
  // immortal marker) and covers a member that dropped mid-leave (never acked → still owed the
  // replay), which the raw awaitLeaveAcks boolean conflated with "nobody was connected". ts is the
  // leave stamp: a genuine later rejoin writes a strictly newer member/<S> ts and outranks the replay.
  async function armPendingLeaveIfUnwitnessed(spaceId, space) {
    if (!space?.topic) return false
    const others = (space.members || []).map((m) => m.publicKey)
    if (others.length === 0) return false
    const acked = takeLeaveAckedKeys(spaceId)
    if (others.every((k) => acked.has(k))) return false
    try {
      const leaveTs = Date.now()
      await persistPendingLeave(spaceId, space.topic, leaveTs)
      registerPendingLeave(spaceId, space.topic, leaveTs)
      log.info('leave unwitnessed — pending-leave marker armed:', spaceId)
      return true
    } catch (err) {
      log.warn('pending-leave persist failed:', err.message)
      return false
    }
  }

  // The teardown's leaveSpaceTopic dropped the topic — re-join it for the replay so a co-member
  // returning THIS session still receives the leave (boot covers restarts). Re-check the live
  // marker rather than a stale armed-flag: an ack that landed mid-teardown already cleared the
  // marker and left the topic, and re-joining here would strand a zombie topic nothing can leave.
  function rejoinPendingLeaveTopicAfterTeardown(spaceId, space) {
    if (!hasPendingLeave(spaceId) || !space?.topic) return
    try { joinPendingLeaveTopic(spaceId, space.topic) } catch (err) {
      log.warn('pending-leave topic rejoin failed:', err.message)
    }
  }

  ipc.handle('space:leave', async (msg) => {
    // A teardown is already in flight (it can outlive the IPC response) — a re-click must be a no-op,
    // not a second run that clobbers the in-flight leave-ack tracking and re-purges half-torn state.
    // Claim the flag SYNCHRONOUSLY before any await, so two near-simultaneous leaves can't both pass
    // the guard during the getSpace round-trip below.
    if (isSpaceLeaving(msg.spaceId)) return { ok: true }
    markSpaceLeaving(msg.spaceId)
    // A pending space was never joined — take the lightweight cancel path instead of
    // the drive-purge teardown, which assumes a materialized drive and crashes without one.
    const pending = await getSpace(msg.spaceId)
    // Recorded up front, while the space record still exists: the teardown deletes it, and the row
    // must carry the name snapshot or it renders as raw hex forever afterwards.
    if (pending) {
      record('space.left', {
        actor: selfActor(),
        space: spaceRef(pending),
        target: { kind: 'space', id: pending.spaceId, name: pending.name },
        subject: { wasPending: pending.status === 'pending' },
      })
    }
    if (pending?.status === 'pending') {
      unmarkSpaceLeaving(msg.spaceId)   // a pending cancel is not a drive teardown
      log.info('cancel pending join:', msg.spaceId)
      // Tell members who saw our request to drop it. A lost frame self-heals: register a pending
      // cancel replayed on every connection until a member acks it applied, and re-join the topic
      // (discard purges it) so a member offline now can still be reached. The initial send goes
      // through sendPendingCancelToConnected so the ack from a currently-connected member is honored.
      if (pending.topic) {
        registerPendingCancel(msg.spaceId, pending.topic, getLocalPublicKeyHex())
        sendPendingCancelToConnected()
      }
      await discardPendingSpace(msg.spaceId)
      // Re-join for replay ONLY if a member hasn't already acked during the teardown above (which
      // clears the pending cancel) — otherwise we'd re-join a purged topic nothing ever leaves.
      if (pending.topic && hasPendingCancel(msg.spaceId)) joinPendingCancelTopic(msg.spaceId, pending.topic)
      return { ok: true }
    }

    closeMemberView(msg.spaceId)
    log.info('leave starting:', msg.spaceId)
    // markSpaceLeaving already set above (before the getSpace await) so files:list reads short-circuit.

    // Run the full teardown as a background task tracking its current phase. The
    // load-bearing signals (leave frame, clearOwnMembership) and the durable catalog-record
    // delete all happen before the heavyweight, occasionally-slow steps (swarm leave, peer
    // core close/compaction, purge) — so if one of those stalls we can answer the renderer
    // and let the rest finish in the background, instead of hanging the UI for the full IPC
    // timeout. `phase` names where it is so a stall is diagnosable from the logs.
    const tracker = { phase: 'start' }
    let space = null
    const teardown = (async () => {
      try {
        // Durable leaving marker BEFORE the member del: a quit anywhere in this teardown is now
        // completed at the next boot (resumeInterruptedLeave) instead of being reverted by the
        // markOwnMembership backfill. Best-effort — without it a crash reverts as before.
        tracker.phase = 'mark-leaving'
        try { await markSpaceLeavingDurable(msg.spaceId) } catch (err) {
          log.warn('durable leaving mark failed:', err.message)
        }
        // Author the durable departure (member/<S> del) BEFORE broadcasting the frame, so it is
        // written + announced when co-members apply the leave — their member-view live-follow can then
        // re-host it and serve it to members who were offline at leave time.
        // Same step order as boot's interrupted-leave pass (shared/spaces/leave-flow.js). The steps
        // differ: this path also stops the in-memory machinery — a still-live chokidar watcher,
        // mirror loop, periodic reconcile or publish lane would keep writing to the drive the purge
        // below closes, and recreate state mid-purge. A fresh boot has none of that to stop.
        await runLeaveTeardown(msg.spaceId, {
          clearMembership: async () => {
            // Best-effort here, unlike the boot pass's hard gate: the purge steps below still have
            // to run, and the durable marker already survives for the next boot to finish.
            try { await clearOwnMembership(msg.spaceId) } catch (err) {
              log.warn('clearOwnMembership failed:', err.message)
            }
            tracker.phase = 'leave-frame'
            try { sendLeaveFrameToConnectedPeers(msg.spaceId) } catch (err) {
              log.warn('leave-frame broadcast failed:', err.message)
            }
          },
          ownedMounts: async () => {
            for (const m of (await listOwnedMounts()).filter((x) => x.spaceId === msg.spaceId)) {
              mounts.cancelPeriodicReconcile(msg.spaceId, m.shareId)
              stopOwnedFolder(msg.spaceId, m.shareId)
              ipc.emit('main-request', { command: 'owned-folder:stop-watcher', args: { shareId: m.shareId } })
              await deleteOwnedMount(msg.spaceId, m.shareId)
            }
            // Awaited: a cancelled publish still writes its revert on the next chunk boundary, and
            // that write must land before the purge below closes the catalog core.
            await stopPublishingForSpace(msg.spaceId)
          },
          // Retire our share advertisements (deletedAt), like the unshare path. Without this our
          // profile bee keeps advertising share/<S>/<id>, so on a rejoin a co-member reads it back
          // and a folder they mirrored re-surfaces before any re-approval.
          shares: async () => {
            for (const s of await readOwnShares(msg.spaceId)) await tombstoneShare(msg.spaceId, s.id)
          },
          foreignMounts: async () => {
            for (const m of (await listForeignMounts()).filter((x) => x.spaceId === msg.spaceId)) {
              await unmountForeignFolder(msg.spaceId, m.shareId)
            }
          },
          // The forget stays below with the rest of the teardown: it must land AFTER the bounded
          // ack flush, which the boot pass has no equivalent of.
          forget: async () => {},
        }, { log, onPhase: (phase) => { tracker.phase = phase } })
        log.info('leave: own state cleared, waiting flush...')

        // Wait (bounded) for connected members to confirm they applied our leave — an observed signal
        // that their durable revokeApproval ran — instead of a blind fixed sleep. Resolves early on
        // full ack coverage; falls back to the cap for pre-upgrade peers that never ack.
        tracker.phase = 'flush'
        await awaitLeaveAcks(msg.spaceId, { capMs: 2000, floorMs: 500 })
        log.info('leave: flush done, gathering members...')

        space = await getSpace(msg.spaceId)
        const members = space?.members || []
        const peerDrivenMembers = members.filter(m => !!m.driveKey)
        const peerDriveCount = peerDrivenMembers.length

        await armPendingLeaveIfUnwitnessed(msg.spaceId, space)

        // Drop the catalog record up front so the leave is durable: if any purge step
        // below fails (or the worker dies mid-teardown), the space is already gone from
        // the list and won't reappear — leftover cores are reclaimable, a stuck space is
        // not. The drive stays in the in-memory map for purgeSpaceDrive.
        tracker.phase = 'forgetSpaceRecord'
        try { await forgetSpaceRecord(msg.spaceId) } catch (err) {
          log.warn('leave: catalog record delete failed:', err.message)
        }
        dropSpaceDownloadRoot(msg.spaceId)

        // Cache-size precompute is best-effort; cap at 2s so a stuck drive read
        // can't block the rest of the leave teardown.
        tracker.phase = 'cache-bytes'
        let totalBytes = 0
        try {
          totalBytes = await Promise.race([
            getSpaceCacheBytes(msg.spaceId),
            new Promise((resolve) => setTimeout(() => resolve(0), 2000)),
          ])
        } catch (err) {
          log.warn('cannot precompute space cache size:', err.message)
        }
        log.info('leave: cache bytes computed:', totalBytes)

        // Must match the number of progress calls below: 1 disconnecting + N
        // cleaningPeer + (N>0 ? compactingPeerCache : 0) + 4 local phases.
        const totalSteps = 5 + peerDriveCount + (peerDriveCount > 0 ? 1 : 0)
        let step = 0

        const progress = (phase, data) => {
          step++
          const payload = { spaceId: msg.spaceId, step, totalSteps, phase }
          if (data) payload.data = data
          if (step === 1) payload.totalBytes = totalBytes
          ipc.emit('event:leave-progress', payload)
        }

        // Cancel + discard any in-flight downloads for this space before the purges, so the
        // overlay/loose engine stops fetching (no orphaned partial) and can't re-write the
        // download-history rows cleanupDownloadHistory/clearPendingForSpace purge below.
        await overlayCancelSpace(msg.spaceId)
        await looseCancelSpace(msg.spaceId)
        // ...and stop SERVING this space to everyone else. The cancels above only walk OUR OWN
        // fetch slots — as the owner we have none, so without this a leave stops nothing on the
        // serving side and the content plane keeps streaming the space's bytes. Runs BEFORE the
        // purges: it needs serveIndex to still resolve hash → space.
        revokeServesForSpace(msg.spaceId)
        bumpServeEpoch()

        tracker.phase = 'leaveSpaceTopic'
        progress('disconnecting')
        await leaveSpaceTopic(msg.spaceId)
        log.info('leave: topic left, cleaning peer drives...')
        // Defer the disk-reclaim compaction (compact: false): purging tombstones the cores (the
        // leave is effective immediately), but a forced full-range compaction scans the WHOLE store
        // and is expensive on a large one — one pass per drive (peer caches here, local cache below)
        // would serially block the leave for tens of seconds. Run a SINGLE coalesced pass in the
        // background after the purges instead.
        tracker.phase = 'cleanupSpaceDrives'
        await cleanupSpaceDrives(msg.spaceId, peerDrivenMembers, (phase, data) => {
          progress(phase, data)
        }, { compact: false })
        log.info('leave: peer drives cleaned, purging local...')

        tracker.phase = 'purge-local'
        await cleanupDownloadHistory(msg.spaceId)
        await clearPendingForSpace(msg.spaceId)
        await purgeSpaceDrive(msg.spaceId, (phase) => {
          progress(phase)
        }, { compact: false })
        try { await purgeOwnCatalog(msg.spaceId, space) } catch (err) {
          log.warn('leave: own catalog purge failed:', err.message)
        }
        await purgeSpace(msg.spaceId)
        tracker.phase = 'forgetUnreferencedPeerCores'
        try { await forgetUnreferencedPeerCores(members) } catch (err) {
          log.warn('leave: peer-core gc failed:', err.message)
        }
        // One background compaction pass for everything purged above — never awaited, so the
        // leave completes as soon as the cores are tombstoned; the bytes come back shortly after.
        compactStore()
          .catch((err) => log.warn('leave: background reclaim compaction failed:', err.message))
        tracker.phase = 'complete'
        log.info('leave: complete (reclaim compaction running in background):', msg.spaceId)
      } finally {
        unmarkSpaceLeaving(msg.spaceId)
        rejoinPendingLeaveTopicAfterTeardown(msg.spaceId, space)
      }
    })()

    // Never hold the renderer past this deadline: the leave is already durable (catalog record
    // dropped) and propagated (leave frame sent) well before the slow steps, so answer now and let
    // any straggling teardown finish in the background. The warn names the stalled phase so a real
    // hang is pinpointable from the console instead of surfacing only as a 30s IPC timeout.
    const LEAVE_RESPOND_DEADLINE_MS = 12000
    const stalled = await Promise.race([
      teardown.then(() => false, () => false),
      new Promise((resolve) => setTimeout(() => resolve(true), LEAVE_RESPOND_DEADLINE_MS)),
    ])
    if (stalled) {
      log.warn('leave: teardown exceeded', LEAVE_RESPOND_DEADLINE_MS, 'ms — stalled at phase:', tracker.phase, '— space', msg.spaceId, '— finishing in background')
      teardown.catch((err) => log.warn('leave: background teardown failed:', err.message))
    }
    return { ok: true }
  })
}
