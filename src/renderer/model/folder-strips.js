// Which work strips a folder screen shows, in which order. The strips live ABOVE the scroll pane,
// so an order that changes under the user is a layout jump — hence one fixed precedence rather
// than "whatever the JSX order happens to be", and hence a pure function the unit suite can pin.
//
// `live` mirrors what ships today and must not drift: the working strip is NOT a live region (its
// counts change about twice a second, which would spam a screen reader) — a separate count-free
// sr-only sentence carries that announcement instead.

/** @import { IconName } from '../types/ui.js' */
/** @import { ShareRole } from '../types/types.js' */
/** @import { MountFault } from '../../shared/contract/mount-fault.js' */
/** @import { IndexSummary } from './index-summary.js' */
/** @import { MirrorSyncSummary } from './mirror-sync.js' */

/** @typedef {'source-missing' | 'fault' | 'paused' | 'working' | 'peer-indexing' | 'owner-offline' | 'over-limit'} StripId */
/** @typedef {'error' | 'warning' | 'info' | 'neutral'} StripTone */
/** @typedef {'locate' | 'resume' | 'pause' | null} StripAction */

/**
 * @typedef {object} StripData
 * @property {'indexing' | 'mirroring' | 'peer-indexing'} [kind]
 * @property {ShareRole} [role]
 * @property {boolean} [scanning]
 * @property {number} [files]
 * @property {number} [bytes]
 * @property {boolean} [indeterminate]
 * @property {number | null} [pct]
 * @property {string | null} [faultCode]
 * @property {number} [shown]
 * @property {number} [total]
 * @property {number} [limit]
 */

/** @typedef {{ id: StripId, tone: StripTone, icon: IconName, live: 'status' | 'alert' | null, action: StripAction, data: StripData | null }} FolderStrip */

/**
 * @typedef {object} DeriveStripsInput
 * @property {ShareRole} role
 * @property {boolean} isYou
 * @property {boolean} [loading]
 * @property {boolean} [error]
 * @property {boolean} [sourceMissing]
 * @property {MountFault | null} [fault]
 * @property {IndexSummary | null} [indexing]
 * @property {boolean} [foreignEnabled]
 * @property {MirrorSyncSummary | null} [mirrorSync]
 * @property {boolean} [ownerOnline]
 * @property {{ truncated: boolean, shown: number, total: number, limit: number } | null} [listing]
 */

/** @typedef {(input: DeriveStripsInput) => FolderStrip | null} StripBuilder */

/** @type {StripBuilder} */
function sourceMissingStrip(input) {
  if (!input.isYou || !input.sourceMissing) return null
  return { id: 'source-missing', tone: 'error', icon: 'warning', live: 'alert', action: 'locate', data: null }
}

// A local fault the user can name: a full disk, a folder that stopped being readable. It outranks
// the paused strip because an auto-paused mirror IS enabled === false, and a Resume on it would
// re-pause it on the next tick.
//
// Both roles carry the retry. An owner's fault is not a stop — the cadence still runs — but that
// cadence is six-hourly, so after freeing the disk the only thing that would clear the strip is a
// file event the user has no reason to produce. The verb re-runs the pass, which either clears the
// fault or records it again.
/** @type {StripBuilder} */
function faultStrip(input) {
  if (!input.fault) return null
  return {
    id: 'fault',
    tone: 'error',
    icon: 'warning',
    live: 'alert',
    action: 'resume',
    data: { role: input.role, faultCode: input.fault.code ?? null },
  }
}

// A folder shows one state, and both a fault and a missing source outrank a pause: each carries the
// action the user can actually take, and the pause is still recorded underneath.
/** @param {DeriveStripsInput} input */
function isPaused(input) {
  if (input.fault || input.sourceMissing) return false
  if (input.isYou) return !!input.indexing?.paused
  return input.role === 'mirrored' && input.foreignEnabled === false
}

/** @type {StripBuilder} */
function pausedStrip(input) {
  if (!isPaused(input)) return null
  return { id: 'paused', tone: 'warning', icon: 'pause', live: 'status', action: 'resume', data: { role: input.role } }
}

/** @type {StripBuilder} */
function workingStrip(input) {
  if (isPaused(input)) return null
  if (input.isYou && input.indexing?.active) {
    const indexing = input.indexing
    return {
      id: 'working',
      tone: 'info',
      icon: 'update',
      live: null,
      action: 'pause',
      data: { kind: 'indexing', scanning: !!indexing.scanning, files: indexing.files, bytes: indexing.bytesQueued, indeterminate: true, pct: null },
    }
  }
  // An unreachable owner means nothing is moving, so "Syncing N files" beside "Archy is offline"
  // would be two strips contradicting each other. The offline one is the true report.
  if (input.role === 'mirrored' && input.mirrorSync?.active && input.ownerOnline !== false) {
    const sync = input.mirrorSync
    return {
      id: 'working',
      tone: 'info',
      icon: 'update',
      live: null,
      action: 'pause',
      data: { kind: 'mirroring', scanning: false, files: sync.files, bytes: sync.bytesRemaining, indeterminate: sync.indeterminate, pct: sync.pct },
    }
  }
  return null
}

// A peer's scan is a statement, never a control: there is nothing here for a member to pause.
/** @type {StripBuilder} */
function peerIndexingStrip(input) {
  const indexing = input.indexing
  if (input.isYou || !indexing?.active || indexing.paused) return null
  return {
    id: 'peer-indexing',
    tone: 'info',
    icon: 'update',
    live: null,
    action: null,
    data: { kind: 'peer-indexing', scanning: !!indexing.scanning, files: indexing.files, bytes: indexing.bytesQueued, indeterminate: true, pct: null },
  }
}

/** @type {StripBuilder} */
function ownerOfflineStrip(input) {
  if (input.isYou || input.ownerOnline !== false) return null
  return { id: 'owner-offline', tone: 'neutral', icon: 'cloud', live: 'status', action: null, data: null }
}

/** @type {StripBuilder} */
function overLimitStrip(input) {
  const listing = input.listing
  if (!listing?.truncated) return null
  return {
    id: 'over-limit',
    tone: 'neutral',
    icon: 'folder',
    live: 'status',
    action: null,
    data: { shown: listing.shown, total: listing.total, limit: listing.limit },
  }
}

// Precedence, top to bottom. A folder can be in several of these at once — offline AND over the
// cap is ordinary — so this is a filter over builders, not a switch.
const BUILDERS = [sourceMissingStrip, faultStrip, pausedStrip, workingStrip, peerIndexingStrip, ownerOfflineStrip, overLimitStrip]

// A failed listing does not clear a durable local fault, and those are the ones the user can act on
// from this screen: a paused mirror still needs its Resume, a missing source still needs its
// Locate, and a folder stopped by a full disk still needs to say so. The banners these replace
// were gated on `!loading` alone for exactly that reason. The rest describe the listing, which is
// what failed, so they go.
/** @type {Set<StripId>} */
const SURVIVES_ERROR = new Set(['source-missing', 'fault', 'paused'])

/** @param {DeriveStripsInput} input @returns {FolderStrip[]} */
export function deriveStrips(input) {
  if (input.loading) return []
  /** @type {FolderStrip[]} */
  const strips = []
  for (const build of BUILDERS) {
    const strip = build(input)
    if (!strip) continue
    if (input.error && !SURVIVES_ERROR.has(strip.id)) continue
    strips.push(strip)
  }
  return strips
}
