// What a mirror owns on disk, and how much of that the persisted record still disagrees with.
//
// Three pieces of per-mount state that live and die together, which is why they share a module and
// a single reset:
//  - `synced`: the owner keys this mirror wrote. A deletion is honoured only for these, so the set
//    is the evidence that makes an owner-side delete safe to apply. In memory it is the
//    authoritative copy; mount.syncedPaths is its boot-time seed and durable snapshot.
//  - `renamedPaths`: the collision mapping. A pre-existing user file at the natural name forces a
//    sibling, and the mapping has to be idempotent across ticks or a re-mount breeds
//    report (1).pdf, report (2).pdf …
//  - the convergence watermark: the owner-catalog version the last converged pass walked, so a
//    settled mirror re-walks only when that version moves.
import fs from 'bare-fs'
import { pathFromMount } from '../transfer/path-guard.js'
import { PARTIAL_SUFFIX } from '../transfer/partial-suffix.js'
import { driveKeyToSegments, nextFreeName } from './path-keys.js'
import { patchForeignMount } from './mount-store.js'

// The on-disk relPath an owner key was materialized as (its natural name unless a conflict forced
// a collision-free sibling). Exported free-standing because share-listing must ask the same
// question from a mount record alone: deriving it from the owner key renders a renamed-but-synced
// file as 'remote'.
export function localRelOf (mount, ownerKey) {
  return mount.renamedPaths?.[ownerKey] || ownerKey
}

export function createMirrorState ({ keyOf, isStopped }) {
  // loopKey -> Set<ownerKey>. Membership is asked once per catalog entry per tick, so it must be
  // O(1): the array scan it replaces made a fully-synced tick quadratic. The set outlives
  // pause/resume (a stopped pass has already written files it must keep owning) and is dropped
  // only on unmount, with the record.
  const syncedSets = new Map()
  // loopKeys whose set / renamedPaths differ from the persisted record.
  const dirty = new Set()
  const convergedHeads = new Map()
  const skippedTicks = new Map()

  function syncedSetFor (mount) {
    const key = keyOf(mount.spaceId, mount.shareId)
    let set = syncedSets.get(key)
    if (!set) {
      set = new Set(mount.syncedPaths || [])
      syncedSets.set(key, set)
    }
    return set
  }

  function syncFields (mount) {
    return { syncedPaths: [...syncedSetFor(mount)], renamedPaths: mount.renamedPaths || {} }
  }

  // Decide the on-disk relPath for a materialized owner entry, never clobbering a file Mirall did
  // not create, and idempotently so repeated ticks / re-mounts converge on one sibling. Same
  // invariant as download-dest.js::resolveDest, but path-key aware and persistent:
  //  1) an established conflict mapping wins — idempotent across ticks;
  //  2) nothing on disk, or a path we already synced at its natural name -> natural;
  //  3) on-disk bytes already equal the share's hash -> natural (this is what lets
  //     unmount -> re-mount adopt the prior copy);
  //  4) a genuine pre-existing user file -> a free sibling, recorded in renamedPaths.
  async function resolveLocalRelPath (mount, ownerKey, ownerHash, hashOf, synced = syncedSetFor(mount), fresh = null) {
    const mapped = mount.renamedPaths?.[ownerKey]
    if (mapped) return mapped

    const naturalAbs = pathFromMount(mount.mountPath, ownerKey)
    if (!fs.existsSync(naturalAbs) || (synced.has(ownerKey) && !fresh?.has(ownerKey))) return ownerKey

    // hashOf must match how ownerHash was computed: the overlay hasher for overlay shares — else
    // the adopt-existing-copy check never matches and a collision sibling is minted.
    //
    // Deliberately NOT short-circuited by the verified-download record: that record proves some
    // local path held this content, not that THIS natural path does. Consulting it here adopts a
    // user's unrelated file at the natural name whenever the mirror had previously written the
    // same content to a collision sibling.
    if (ownerHash) {
      try { if (await hashOf(naturalAbs) === ownerHash) return ownerKey } catch {}
    }

    const segs = driveKeyToSegments(ownerKey)
    const leaf = segs.pop()
    const dir = segs.join('/')
    const isTaken = (name) => {
      const abs = pathFromMount(mount.mountPath, dir ? dir + '/' + name : name)
      // A candidate is taken by a real file OR an in-flight partial, so we never mint a sibling
      // name onto another transfer's partial.
      return fs.existsSync(abs) || fs.existsSync(abs + PARTIAL_SUFFIX)
    }
    const localRel = (dir ? dir + '/' : '') + nextFreeName(leaf, isTaken)
    ;(mount.renamedPaths ||= {})[ownerKey] = localRel
    dirty.add(keyOf(mount.spaceId, mount.shareId))
    return localRel
  }

  // Drop conflict mappings whose owner key the share no longer carries, so the map can't
  // accumulate stale entries across ticks.
  function pruneRenamedPaths (mount, onDrive) {
    if (!mount.renamedPaths) return
    for (const ownerKey of Object.keys(mount.renamedPaths)) {
      if (onDrive.has(ownerKey)) continue
      delete mount.renamedPaths[ownerKey]
      dirty.add(keyOf(mount.spaceId, mount.shareId))
    }
  }

  return {
    syncedSetFor,
    syncFields,
    resolveLocalRelPath,
    pruneRenamedPaths,

    // `fresh` collects the keys this pass claimed. Ownership is recorded BEFORE the write lands
    // (so a cancelled pass still owns what it wrote), but the collision check must still see such
    // a path as NOT-yet-ours — otherwise a pre-existing user file at the natural name is adopted
    // instead of getting a sibling. The persisted record and the "did we write this before?"
    // question are two different things.
    recordSynced (key, set, ownerKey, fresh) {
      if (set.has(ownerKey)) return
      set.add(ownerKey)
      fresh?.add(ownerKey)
      dirty.add(key)
    },
    forgetSynced (key, set, ownerKey) {
      if (set.delete(ownerKey)) dirty.add(key)
    },
    markClean: (key) => dirty.delete(key),

    // Persist once per pass, only when something changed, and never from a pass that was
    // cancelled: a pause persists the set itself, and unmount deleted the record. Writing it on
    // every tick of an owner-online mirror appended ~36 B per path to the mounts bee every 30 s.
    async persist (mount, key, gen) {
      if (!dirty.has(key) || isStopped(key, gen)) return
      if (await patchForeignMount(mount.spaceId, mount.shareId, syncFields(mount))) dirty.delete(key)
    },

    watermark: (key) => convergedHeads.get(key) ?? null,
    setWatermark: (key, version) => convergedHeads.set(key, version),
    skipped: (key) => skippedTicks.get(key) || 0,
    noteSkipped: (key, n) => skippedTicks.set(key, n),
    forgetConverged (key) {
      convergedHeads.delete(key)
      skippedTicks.delete(key)
    },

    // Every cache here is keyed by mount PATH in effect, not by path itself: the synced set
    // records which entries this mount already owns on disk. Both unmount and relocate must drop
    // them — an inherited set would claim files exist at a path the mount no longer uses.
    reset (key) {
      syncedSets.delete(key)
      dirty.delete(key)
      convergedHeads.delete(key)
      skippedTicks.delete(key)
    },
  }
}
