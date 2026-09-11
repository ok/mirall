import test from 'brittle'
import { deriveFolderStatus } from '../../src/renderer/folderStatus.js'
import { badgeStyle } from '../../src/renderer/statusBadge.js'
import { BADGE_STATUSES } from '../../src/shared/contract/statuses.js'

const BASE = {
  role: 'mine',
  sourceMissing: false,
  fault: false,
  paused: false,
  mirrorEnabled: true,
  indexing: false,
  mirrorSyncing: false,
}

test('a missing source outranks every other state', (t) => {
  const status = deriveFolderStatus({ ...BASE, sourceMissing: true, paused: true, indexing: true })
  t.is(status.labelKey, 'folder.statusMissing')
})

test('a paused index outranks an active one', (t) => {
  const status = deriveFolderStatus({ ...BASE, paused: true, indexing: true })
  t.is(status.labelKey, 'folder.statusPaused')
})

test('a paused mirror reads the same as a paused index', (t) => {
  const owner = deriveFolderStatus({ ...BASE, paused: true })
  const mirror = deriveFolderStatus({ ...BASE, role: 'mirrored', mirrorEnabled: false })
  t.is(mirror.labelKey, owner.labelKey, 'one word for one state, both roles')
  t.is(mirror.badge, owner.badge, 'and one colour')
})

test('work in progress is role-specific', (t) => {
  t.is(deriveFolderStatus({ ...BASE, indexing: true }).labelKey, 'folder.statusAdding')
  t.is(deriveFolderStatus({ ...BASE, role: 'mirrored', mirrorSyncing: true }).labelKey, 'folder.statusSyncing')
})

test('an owner does not report a mirror sync, and a mirror does not report indexing', (t) => {
  t.is(deriveFolderStatus({ ...BASE, mirrorSyncing: true }).labelKey, 'folder.statusUpToDate', 'owner ignores mirror state')
  t.is(deriveFolderStatus({ ...BASE, role: 'mirrored', indexing: true }).labelKey, 'folder.statusUpToDate', 'mirror ignores our index')
})

test('browse is passive', (t) => {
  t.is(deriveFolderStatus({ ...BASE, role: 'browse' }).labelKey, 'folder.statusBrowseOnly')
})

// The strip above the listing announces every state worth announcing, so the tile is a label and a
// colour and nothing more — anything else here would read the same change twice.
test('the status is exactly a label and a badge', (t) => {
  for (const input of [{ ...BASE, sourceMissing: true }, { ...BASE, paused: true }, { ...BASE, indexing: true }, BASE]) {
    t.alike(Object.keys(deriveFolderStatus(input)).sort(), ['badge', 'labelKey'])
  }
})

test('an idle folder is up to date', (t) => {
  t.is(deriveFolderStatus(BASE).labelKey, 'folder.statusUpToDate')
  t.is(deriveFolderStatus({ ...BASE, role: 'mirrored' }).labelKey, 'folder.statusUpToDate')
})

// The pill borrows the file rows' palette on purpose. A token that isn't in that table would
// render an unstyled pill, and the tile is the one place nobody would notice.
test('every badge names a real style in the shared table', (t) => {
  const cases = [
    { ...BASE, sourceMissing: true },
    { ...BASE, paused: true },
    { ...BASE, indexing: true },
    { ...BASE, role: 'mirrored', mirrorSyncing: true },
    { ...BASE, role: 'browse' },
    BASE,
  ]
  for (const input of cases) {
    const status = deriveFolderStatus(input)
    t.ok(badgeStyle(status.badge)?.classes, `${status.labelKey} -> ${status.badge} is a known badge`)
  }
})

// An auto-paused mirror is enabled === false, so without the fault outranking the pause the tile
// called a folder stopped by a full disk "Paused" — the user's own doing, as far as it read.
test('a fault outranks both pauses and reads as an error', (t) => {
  const owner = deriveFolderStatus({ ...BASE, fault: true, paused: true })
  t.is(owner.labelKey, 'folder.statusFault')
  t.is(owner.badge, 'error')

  const mirror = deriveFolderStatus({ ...BASE, role: 'mirrored', fault: true, mirrorEnabled: false })
  t.is(mirror.labelKey, 'folder.statusFault', 'the same for a mirror, whose fault always looks like a pause')
  t.ok(badgeStyle(mirror.badge), 'and the badge token exists')
})

test('a missing source still outranks a fault', (t) => {
  const status = deriveFolderStatus({ ...BASE, sourceMissing: true, fault: true })
  t.is(status.labelKey, 'folder.statusMissing', 'the more specific state wins')
})

// With the owner away nothing can be fetched, so a mirror demonstrably short of the owner's listing
// must not sit under an "Up to date" pill beside a strip saying they are offline.
const MIRROR_OFFLINE = { ...BASE, role: 'mirrored', ownerOnline: false, incomplete: true }

test('REGRESSION (FIX-M4-1): an incomplete mirror with an offline owner does not claim to be up to date', (t) => {
  const s = deriveFolderStatus(MIRROR_OFFLINE)
  t.is(s.labelKey, 'status.ownerOffline')
  t.is(s.badge, 'owner-offline')
})

test('a complete mirror with an offline owner is still up to date', (t) => {
  // Deliberate: up to date as of last contact. Flipping this would fire on every healthy mirror
  // the moment its owner closed a laptop.
  t.is(deriveFolderStatus({ ...MIRROR_OFFLINE, incomplete: false }).labelKey, 'folder.statusUpToDate')
})

test('an unknown on-device count never manufactures the offline state', (t) => {
  const { incomplete, ...noSignal } = MIRROR_OFFLINE
  t.is(deriveFolderStatus(noSignal).labelKey, 'folder.statusUpToDate')
})

test('the user\'s own pause outranks the outage', (t) => {
  t.is(deriveFolderStatus({ ...MIRROR_OFFLINE, mirrorEnabled: false }).labelKey, 'folder.statusPaused')
})

test('a fault outranks the outage', (t) => {
  t.is(deriveFolderStatus({ ...MIRROR_OFFLINE, fault: true }).labelKey, 'folder.statusFault')
})

test('a missing source outranks the outage', (t) => {
  t.is(deriveFolderStatus({ ...MIRROR_OFFLINE, sourceMissing: true }).labelKey, 'folder.statusMissing')
})

test('an owned folder is unaffected by owner presence', (t) => {
  t.is(deriveFolderStatus({ ...BASE, role: 'mine', ownerOnline: false, incomplete: true }).labelKey, 'folder.statusUpToDate')
})

test('REGRESSION (FIX-M4-1): a self-mirror never reads as owner-offline', (t) => {
  // Presence leases track remote peers only, so our own key is never in the map; the caller
  // resolves a self-owned share to online before it gets here.
  t.is(deriveFolderStatus({ ...MIRROR_OFFLINE, ownerOnline: true }).labelKey, 'folder.statusUpToDate')
})

test('the offline state is still exactly a label and a badge', (t) => {
  t.alike(Object.keys(deriveFolderStatus(MIRROR_OFFLINE)).sort(), ['badge', 'labelKey'])
})

test('every badge deriveFolderStatus can return is a legal BADGE_STATUSES token', (t) => {
  const cases = [MIRROR_OFFLINE, { ...BASE, sourceMissing: true }, { ...BASE, fault: true },
    { ...BASE, role: 'mirrored', mirrorSyncing: true }, { ...BASE, role: 'browse' }, BASE]
  for (const c of cases) t.ok(BADGE_STATUSES.includes(deriveFolderStatus(c).badge), `${deriveFolderStatus(c).badge} is a BADGE_STATUSES`)
})
