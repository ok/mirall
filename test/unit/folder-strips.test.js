import test from 'brittle'
import { deriveStrips } from '../../src/renderer/folderStrips.js'

const IDLE_INDEX = { active: false, scanning: false, paused: false, files: 0, bytesQueued: 0 }
const OWNER = { role: 'mine', isYou: true, indexing: IDLE_INDEX, ownerOnline: true }
const MIRROR = { role: 'mirrored', isYou: false, indexing: IDLE_INDEX, foreignEnabled: true, ownerOnline: true, mirrorSync: { active: false, files: 0, onDevice: 0, bytesRemaining: 0, pct: null, indeterminate: false } }

const ids = (strips) => strips.map((s) => s.id)

test('an idle folder shows nothing at all', (t) => {
  t.alike(ids(deriveStrips(OWNER)), [], 'no strip, so the pane keeps the height')
  t.alike(ids(deriveStrips(MIRROR)), [])
})

test('nothing renders while the listing is still loading', (t) => {
  const working = { ...OWNER, indexing: { ...IDLE_INDEX, active: true, files: 3 } }
  t.alike(ids(deriveStrips({ ...working, loading: true })), [])
})

// A failed listing does not clear a durable LOCAL fault, and those are the two the user can still
// act on from this screen. The rest describe the listing, which is what failed.
test('an error keeps the strips that carry a way out, and drops the rest', (t) => {
  const paused = deriveStrips({ ...MIRROR, error: true, foreignEnabled: false, ownerOnline: false })
  t.alike(ids(paused), ['paused'], 'a paused mirror still offers Resume behind the error panel')

  const missing = deriveStrips({ ...OWNER, error: true, sourceMissing: true })
  t.alike(ids(missing), ['source-missing'], 'and a missing source still offers Locate')

  const noise = deriveStrips({
    ...MIRROR,
    error: true,
    ownerOnline: false,
    indexing: { ...IDLE_INDEX, active: true, files: 2 },
    listing: { truncated: true, shown: 5000, total: 8431, limit: 5000 },
  })
  t.alike(ids(noise), [], 'nothing that describes a listing that failed to load')
})

test('the owner gets one working strip carrying Pause and no live region', (t) => {
  const strips = deriveStrips({ ...OWNER, indexing: { ...IDLE_INDEX, active: true, files: 4, bytesQueued: 2900 } })
  t.alike(ids(strips), ['working'])
  t.is(strips[0].action, 'pause', 'one verb — Stop is gone')
  t.is(strips[0].live, null, 'counts change ~2x/s, so this is not announced')
  t.is(strips[0].data.kind, 'indexing')
})

test('a mirror gets the same strip shape from its own rows', (t) => {
  const strips = deriveStrips({ ...MIRROR, mirrorSync: { active: true, files: 6, onDevice: 18, bytesRemaining: 128, pct: 62, indeterminate: false } })
  t.alike(ids(strips), ['working'])
  t.is(strips[0].action, 'pause', 'the verb the mirror never had')
  t.is(strips[0].data.kind, 'mirroring')
  t.is(strips[0].data.pct, 62)
})

test('paused replaces working, in both roles, and offers the way out', (t) => {
  const owner = deriveStrips({ ...OWNER, indexing: { ...IDLE_INDEX, active: true, paused: true, files: 4 } })
  t.alike(ids(owner), ['paused'])
  t.is(owner[0].action, 'resume')
  t.is(owner[0].live, 'status')

  const mirror = deriveStrips({ ...MIRROR, foreignEnabled: false, mirrorSync: { active: true, files: 2, onDevice: 1, bytesRemaining: 1, pct: 10, indeterminate: false } })
  t.alike(ids(mirror), ['paused'])
  t.is(mirror[0].action, 'resume', 'the button the paused mirror lacked')
  t.is(mirror[0].data.role, 'mirrored', 'so the sentence can say what is paused')
})

test('a missing source is an alert and carries a recovery, not a state verb', (t) => {
  const strips = deriveStrips({ ...OWNER, sourceMissing: true })
  t.alike(ids(strips), ['source-missing'])
  t.is(strips[0].live, 'alert')
  t.is(strips[0].action, 'locate')
})

test('a peer scan is a statement — no verb for either non-owner role', (t) => {
  const indexing = { ...IDLE_INDEX, active: true, files: 3 }
  for (const role of ['browse', 'mirrored']) {
    const strips = deriveStrips({ ...MIRROR, role, indexing })
    t.is(strips.find((s) => s.id === 'peer-indexing')?.action, null, role + ' cannot pause someone else’s scan')
  }
})

test('an unreachable owner replaces the working strip rather than doubling it', (t) => {
  const syncing = { active: true, files: 12, onDevice: 3, bytesRemaining: 900, pct: 20, indeterminate: false }
  const online = deriveStrips({ ...MIRROR, mirrorSync: syncing })
  t.alike(ids(online), ['working'], 'reachable owner: the sync is real work')
  const offline = deriveStrips({ ...MIRROR, mirrorSync: syncing, ownerOnline: false })
  t.alike(ids(offline), ['owner-offline'], 'unreachable owner: nothing is moving, and only one strip says so')
})

test('a member never gets a working strip from the owner’s scan', (t) => {
  const strips = deriveStrips({ ...MIRROR, indexing: { ...IDLE_INDEX, active: true, files: 3 } })
  t.absent(ids(strips).includes('working'), 'that is the owner’s work, not ours')
})

test('several conditions stack in one fixed order', (t) => {
  const base = {
    ...MIRROR,
    indexing: { ...IDLE_INDEX, active: true, files: 2 },
    mirrorSync: { active: true, files: 1, onDevice: 0, bytesRemaining: 5, pct: null, indeterminate: true },
    listing: { truncated: true, shown: 5000, total: 8431, limit: 5000 },
  }
  t.alike(ids(deriveStrips(base)), ['working', 'peer-indexing', 'over-limit'], 'ours first, then theirs, then the caveats')
  t.alike(ids(deriveStrips({ ...base, ownerOnline: false })), ['peer-indexing', 'owner-offline', 'over-limit'],
    'and an unreachable owner takes our sync out of the stack rather than adding to it')
})

test('the over-limit strip carries the numbers it reports', (t) => {
  const strips = deriveStrips({ ...OWNER, listing: { truncated: true, shown: 5000, total: 8431, limit: 5000 } })
  t.alike(ids(strips), ['over-limit'])
  t.is(strips[0].data.total, 8431)
  t.is(strips[0].live, 'status')
})

// The fault strip: the only surface either role has for a durable local fault. Before it, the
// owner's fault had none at all (its status was written and read by nothing) and the mirror's
// rendered as the plain paused strip with a Resume that re-paused it on the next tick.
test('a faulted owner gets the fault strip, an alert, and no verb', (t) => {
  const strips = deriveStrips({ ...OWNER, fault: { status: 'paused-enospc', code: 'TRANSFER_DISK_FULL' } })
  t.alike(ids(strips), ['fault'])
  t.is(strips[0].tone, 'error')
  t.is(strips[0].live, 'alert', 'a folder that stopped syncing must be announced')
  t.is(strips[0].action, null, 'nothing was stopped, so there is nothing to resume')
  t.is(strips[0].data.faultCode, 'TRANSFER_DISK_FULL', 'the reason travels as a code, not a message')
})

test('a faulted mirror gets the fault strip INSTEAD of the paused one, carrying a retry', (t) => {
  const strips = deriveStrips({ ...MIRROR, foreignEnabled: false, fault: { status: 'paused-enospc', code: 'TRANSFER_DISK_FULL' } })
  t.alike(ids(strips), ['fault'], 'two strips for one condition would contradict each other')
  t.is(strips[0].action, 'resume', 'the mirror really was stopped, so a retry is honest')
})

test('a user pause is still a pause', (t) => {
  t.alike(ids(deriveStrips({ ...MIRROR, foreignEnabled: false })), ['paused'])
  t.alike(ids(deriveStrips({ ...OWNER, indexing: { ...IDLE_INDEX, paused: true } })), ['paused'])
})

test('a fault outranks a missing source nowhere, and survives a failed listing', (t) => {
  const fault = { status: 'paused-error', code: 'TRANSFER_PERMISSION' }
  t.alike(ids(deriveStrips({ ...OWNER, sourceMissing: true, fault })), ['source-missing', 'fault'],
    'the source-missing strip carries the Locate, so it stays on top')
  t.alike(ids(deriveStrips({ ...OWNER, error: true, fault })), ['fault'],
    'a listing that failed to load does not clear a durable local fault')
})

test('a faulted owner can still be working — the fault describes the last pass, not the queue', (t) => {
  const strips = deriveStrips({
    ...OWNER,
    fault: { status: 'paused-enospc', code: 'TRANSFER_DISK_FULL' },
    indexing: { ...IDLE_INDEX, active: true, files: 3 },
  })
  t.alike(ids(strips), ['fault', 'working'])
})
