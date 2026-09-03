// Which work strips a folder screen shows, in which order. The strips live ABOVE the scroll pane,
// so an order that changes under the user is a layout jump — hence one fixed precedence rather
// than "whatever the JSX order happens to be", and hence a pure function the unit suite can pin.
//
// `live` mirrors what ships today and must not drift: the working strip is NOT a live region (its
// counts change about twice a second, which would spam a screen reader) — a separate count-free
// sr-only sentence carries that announcement instead.

function sourceMissingStrip (input) {
  if (!input.isYou || !input.sourceMissing) return null
  return { id: 'source-missing', tone: 'error', icon: 'warning', live: 'alert', action: 'locate', data: null }
}

// A local fault the user can name: a full disk, a folder that stopped being readable. It outranks
// the paused strip because an auto-paused mirror IS enabled === false — so a mirror stopped by a
// full disk used to render "Paused" with a Resume that re-paused it on the next tick, which told
// the user they had paused it themselves.
//
// Both roles carry the retry. An owner's fault is not a stop — the cadence still runs — but that
// cadence is six-hourly, so after freeing the disk the only thing that would clear the strip is a
// file event the user has no reason to produce. The verb re-runs the pass, which either clears the
// fault or records it again.
function faultStrip (input) {
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

function isPaused (input) {
  if (input.fault) return false
  if (input.isYou) return !!input.indexing?.paused
  return input.role === 'mirrored' && input.foreignEnabled === false
}

function pausedStrip (input) {
  if (!isPaused(input)) return null
  return { id: 'paused', tone: 'warning', icon: 'pause', live: 'status', action: 'resume', data: { role: input.role } }
}

function workingStrip (input) {
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
function peerIndexingStrip (input) {
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

function ownerOfflineStrip (input) {
  if (input.isYou || input.ownerOnline !== false) return null
  return { id: 'owner-offline', tone: 'neutral', icon: 'cloud', live: 'status', action: null, data: null }
}

function overLimitStrip (input) {
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
const SURVIVES_ERROR = new Set(['source-missing', 'fault', 'paused'])

export function deriveStrips (input) {
  if (input.loading) return []
  const strips = []
  for (const build of BUILDERS) {
    const strip = build(input)
    if (!strip) continue
    if (input.error && !SURVIVES_ERROR.has(strip.id)) continue
    strips.push(strip)
  }
  return strips
}
