import test from 'brittle'
import { deriveFolderStatus } from '../../src/renderer/folderStatus.js'
import { badgeStyle } from '../../src/renderer/statusBadge.js'

const BASE = {
  role: 'mine',
  sourceMissing: false,
  indexPaused: false,
  mirrorEnabled: true,
  indexing: false,
  mirrorSyncing: false,
}

test('a missing source outranks every other state', (t) => {
  const status = deriveFolderStatus({ ...BASE, sourceMissing: true, indexPaused: true, indexing: true })
  t.is(status.labelKey, 'folder.statusMissing')
})

test('a paused index outranks an active one', (t) => {
  const status = deriveFolderStatus({ ...BASE, indexPaused: true, indexing: true })
  t.is(status.labelKey, 'folder.statusPaused')
})

test('a paused mirror reads the same as a paused index', (t) => {
  const owner = deriveFolderStatus({ ...BASE, indexPaused: true })
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
  for (const input of [{ ...BASE, sourceMissing: true }, { ...BASE, indexPaused: true }, { ...BASE, indexing: true }, BASE]) {
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
    { ...BASE, indexPaused: true },
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
