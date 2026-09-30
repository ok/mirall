// What a mirror owns on disk, and how much of that the persisted record still disagrees with.
//
// Three pieces of per-mount state that live and die together, which is why they share a module and
// a single reset:
//  - `synced`: the owner keys whose bytes this mirror landed or adopted. The owner's delete is
//    considered only for these, and even then applied only to a copy the verified record still
//    vouches for. In memory it is the authoritative copy; mount.syncedPaths is its boot-time seed
//    and durable snapshot.
//  - `renamedPaths`: the collision mapping. A pre-existing user file at the natural name forces a
//    sibling, recorded once the owner's bytes land there, so the mapping is idempotent across
//    ticks and a re-mount does not breed report (1).pdf, report (2).pdf …
//  - the convergence watermark: the owner-catalog version the last converged pass walked, so a
//    settled mirror re-walks only when that version moves.
import fs from 'bare-fs'
import { pathFromMount } from './path-guard.js'
import { nameTakenAt } from '../transfer/download-dest.js'
import { driveKeyToSegments, nextFreeName } from './path-keys.js'
import { mirrorKey } from './mirror-policy.js'

// A free name for `relPath` beside it in the mirror: `pickName(leaf, isTaken)` chooses the leaf
// (nextFreeName for a collision sibling, conflictCopyName for a conflict copy) and the directory
// is kept.
export function freeMirrorRel(mountPath, relPath, pickName) {
  const segs = driveKeyToSegments(relPath)
  const leaf = segs.pop()
  const dir = segs.join('/')
  const isTaken = (name) => nameTakenAt(pathFromMount(mountPath, dir ? dir + '/' + name : name))
  return (dir ? dir + '/' : '') + pickName(leaf, isTaken)
}

// The on-disk relPath an owner key was materialized as (its natural name unless a conflict forced
// a collision-free sibling). Exported free-standing because share-listing must ask the same
// question from a mount record alone: deriving it from the owner key renders a renamed-but-synced
// file as 'remote'.
export function localRelOf(mount, ownerKey) {
  return mount.renamedPaths?.[ownerKey] || ownerKey
}

// The inverse: the owner key a mount materialized at `localRel`. Only a collision sibling differs
// from its owner key, so the map is scanned rather than indexed — it holds a handful of entries.
export function ownerKeyOf(mount, localRel) {
  for (const [ownerKey, rel] of Object.entries(mount.renamedPaths ?? {})) if (rel === localRel) return ownerKey
  return localRel
}

export function createMirrorState() {
  // mirrorKey -> Set<ownerKey>. Membership is asked once per catalog entry per tick, so it must be
  // O(1): the array scan it replaces made a fully-synced tick quadratic. The set outlives
  // pause/resume (a stopped pass has already written files it must keep owning) and is dropped
  // only on unmount, with the record.
  const syncedSets = new Map()
  // mirrorKey -> the collision map, shared by reference with the mount object a pass holds. Held
  // here like the synced set, so a mapping claimed by a landing outlives the pass that landed it:
  // the pause and the next persist both read it from here.
  const renamedMaps = new Map()
  // mirrorKey -> Map<ownerKey, sibling> picked for bytes that have not landed yet. Never persisted
  // and never ownership: it only lets an interrupted fetch resume into the same sibling, whose
  // partial would otherwise make the name read as taken and breed report (2).pdf.
  const pendingSiblings = new Map()
  // mirrorKeys whose set / renamedPaths differ from the persisted record.
  const dirty = new Set()
  // A pass holds the set and map it bound at its start. Once a relocate or unmount has reset the
  // key, those are orphans: a cancelled pass still mutates them, but never marks the key's
  // current state dirty and never recreates it.
  const markDirty = (key, registry, held) => { if (registry.get(key) === held) dirty.add(key) }
  const convergedHeads = new Map()
  const skippedTicks = new Map()
  // mirrorKeys a reader asked to have walked. Cleared when a walk starts, so a request that lands
  // while a walk is already past the file keeps that walk from converging and the next one runs.
  const walkRequests = new Set()

  function syncedSetFor(mount) {
    const key = mirrorKey(mount.spaceId, mount.shareId)
    let set = syncedSets.get(key)
    if (!set) {
      set = new Set(mount.syncedPaths || [])
      syncedSets.set(key, set)
    }
    return set
  }

  // Binds the map to `mount` as well, so every reader of mount.renamedPaths in the pass sees it.
  function renamedFor(mount) {
    const key = mirrorKey(mount.spaceId, mount.shareId)
    let map = renamedMaps.get(key)
    if (!map) {
      map = { ...mount.renamedPaths }
      renamedMaps.set(key, map)
    }
    mount.renamedPaths = map
    return map
  }

  function syncFields(mount) {
    return { syncedPaths: [...syncedSetFor(mount)], renamedPaths: { ...renamedFor(mount) } }
  }

  // Decide the on-disk relPath for a materialized owner entry, never clobbering a file Mirall did
  // not create, and idempotently so repeated ticks / re-mounts converge on one sibling. Same
  // invariant as download-dest.js::resolveDest, but path-key aware and persistent:
  //  1) an established conflict mapping wins — idempotent across ticks;
  //  2) nothing on disk, or a path we already synced at its natural name -> natural;
  //  3) on-disk bytes already equal the share's hash -> natural (this is what lets
  //     unmount -> re-mount adopt the prior copy);
  //  4) a genuine pre-existing user file -> a sibling: the one picked for this key before, while
  //     no file has appeared at it, else a free one. Only remembered as pending here; the mapping
  //     is claimed by recordRenamed once the bytes land.
  async function resolveLocalRelPath(mount, ownerKey, ownerHash, hashOf, synced = syncedSetFor(mount)) {
    const mapped = mount.renamedPaths?.[ownerKey]
    if (mapped) return mapped

    const naturalAbs = pathFromMount(mount.mountPath, ownerKey)
    if (!fs.existsSync(naturalAbs) || synced.has(ownerKey)) return ownerKey

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

    return pendingSiblingFor(mount, ownerKey)
  }

  function pendingSiblingFor(mount, ownerKey) {
    const key = mirrorKey(mount.spaceId, mount.shareId)
    let pending = pendingSiblings.get(key)
    if (!pending) pendingSiblings.set(key, pending = new Map())
    const picked = pending.get(ownerKey)
    if (picked && !fs.existsSync(pathFromMount(mount.mountPath, picked))) return picked
    const localRel = freeMirrorRel(mount.mountPath, ownerKey, nextFreeName)
    pending.set(ownerKey, localRel)
    return localRel
  }

  function recordRenamed(mount, ownerKey, localRel) {
    pendingSiblings.get(mirrorKey(mount.spaceId, mount.shareId))?.delete(ownerKey)
    const map = mount.renamedPaths ?? renamedFor(mount)
    if (localRel === ownerKey || map[ownerKey] === localRel) return
    map[ownerKey] = localRel
    markDirty(mirrorKey(mount.spaceId, mount.shareId), renamedMaps, map)
  }

  // Drop conflict mappings whose owner key the share no longer carries, so the map can't
  // accumulate stale entries across ticks.
  function pruneRenamedPaths(mount, onDrive) {
    if (!mount.renamedPaths) return
    for (const ownerKey of Object.keys(mount.renamedPaths)) {
      if (onDrive.has(ownerKey)) continue
      delete mount.renamedPaths[ownerKey]
      markDirty(mirrorKey(mount.spaceId, mount.shareId), renamedMaps, mount.renamedPaths)
    }
  }

  return {
    syncedSetFor,
    renamedFor,
    syncFields,
    resolveLocalRelPath,
    recordRenamed,
    pruneRenamedPaths,

    // Called only once the entry is present on disk: a row that was skipped, blocked or failed
    // owns nothing, or the owner's later delete of it would reach whatever file the user put there.
    recordSynced(key, set, ownerKey) {
      if (set.has(ownerKey)) return
      set.add(ownerKey)
      markDirty(key, syncedSets, set)
    },
    forgetSynced(key, set, ownerKey) {
      if (set.delete(ownerKey)) markDirty(key, syncedSets, set)
    },
    markClean: (key) => dirty.delete(key),

    // Persist once per pass, only when something changed: an unconditional write costs ~36 B per
    // path per tick in the mounts bee.
    async persist(writer, mount, key) {
      if (!dirty.has(key)) return
      if (await writer.mutate((m) => ({ ...m, ...syncFields(mount) }))) dirty.delete(key)
    },

    watermark: (key) => convergedHeads.get(key) ?? null,
    setWatermark: (key, version) => convergedHeads.set(key, version),
    skipped: (key) => skippedTicks.get(key) || 0,
    noteSkipped: (key, n) => skippedTicks.set(key, n),
    forgetConverged(key) {
      convergedHeads.delete(key)
      skippedTicks.delete(key)
    },
    // Returns whether the mirror had converged: only then is it skipping ticks, and only then is a
    // walk worth asking for before the next poll.
    requestWalk(key) {
      const converged = convergedHeads.has(key)
      walkRequests.add(key)
      convergedHeads.delete(key)
      skippedTicks.delete(key)
      return converged
    },
    beginWalk: (key) => walkRequests.delete(key),
    walkRequested: (key) => walkRequests.has(key),

    // Every cache here is keyed by mount PATH in effect, not by path itself: the synced set
    // records which entries this mount already owns on disk. Both unmount and relocate must drop
    // them — an inherited set would claim files exist at a path the mount no longer uses.
    reset(key) {
      syncedSets.delete(key)
      renamedMaps.delete(key)
      pendingSiblings.delete(key)
      dirty.delete(key)
      convergedHeads.delete(key)
      skippedTicks.delete(key)
      walkRequests.delete(key)
    },
  }
}
