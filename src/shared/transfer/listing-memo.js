// The per-catalog memo behind files:list: the entries a complete read of one peer catalog returned,
// watermarked on the catalog version that read saw. A listing consults it per member through the
// mirror loop's shouldWalk, so an unchanged catalog costs a property read instead of a head sync
// and a drain, and a backstop re-reads every Nth consult regardless.
//
// Only entries are memoised. Claims, verified records, pending rows, engine slots and presence are
// re-read by every listing, so a row's status keeps its one home and no local change needs to bust
// this memo. A read forgets its key before it starts and only a complete read writes one back, so a
// stalled read keeps flagging its space for the convergence re-poke and never skips.
import { shouldWalk } from '../folders/mirror-policy.js'

const memos = new Map() // spaceId -> Map<catalogKeyHex, { watermark, skipped, entries }>

function write(spaceId, keyHex, watermark, entries) {
  let forSpace = memos.get(spaceId)
  if (!forSpace) {
    forSpace = new Map()
    memos.set(spaceId, forSpace)
  }
  forSpace.set(keyHex, { watermark, skipped: 0, entries })
}

// Before a listing reads one catalog at the live `version` (null reads). On a skip, the memoised
// entries, with the skip counted toward the backstop; otherwise entries is null and `reason` says
// why the catalog must be read.
export function takeListingMemo(spaceId, keyHex, version, { fullReadEvery }) {
  const memo = memos.get(spaceId)?.get(keyHex)
  const { walk, reason } = shouldWalk({ watermark: memo?.watermark ?? null, version, skipped: memo?.skipped ?? 0, fullWalkEvery: fullReadEvery })
  if (walk || !memo) return { entries: null, reason }
  memo.skipped += 1
  return { entries: memo.entries, reason: null }
}

// Forgets the key for the read `reason` names. A backstop read is the one read with nothing saying
// the catalog moved, so its prior entry is handed back for settleListingRead to keep if the read
// cannot finish: a stalled drain reads the same local version, and dropping a sound memo would make
// every later listing pay the read budget for an owner who is merely away.
export function beginListingRead(spaceId, keyHex, reason) {
  const forSpace = memos.get(spaceId)
  const prior = forSpace?.get(keyHex) ?? null
  forSpace?.delete(keyHex)
  return reason === 'backstop' ? prior : null
}

// Records a read's outcome and returns the entries the listing shows for it: the read's own when it
// completed or had no prior to fall back on, the kept prior's otherwise. `read` is null for a read
// that threw.
export function settleListingRead(spaceId, keyHex, read, prior = null) {
  if (read?.complete && typeof read.version === 'number') {
    write(spaceId, keyHex, read.version, read.entries)
    return read.entries
  }
  if (!prior) return read?.entries ?? []
  write(spaceId, keyHex, prior.watermark, prior.entries)
  return prior.entries
}

// Drops the catalogs of members no longer in the space, so the memo holds one entry per current one.
export function retainListingMemo(spaceId, keyHexes) {
  const forSpace = memos.get(spaceId)
  if (!forSpace) return
  for (const keyHex of forSpace.keys()) if (!keyHexes.has(keyHex)) forSpace.delete(keyHex)
}

export function forgetListingMemo(spaceId) {
  memos.delete(spaceId)
}

export function resetListingMemo() {
  memos.clear()
}
