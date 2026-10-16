import test from 'brittle'
import { folderToastDecision } from '../../src/renderer/model/download-folder-toast.js'

const HOST = { home: '/Users/me', sep: '/', caseFolds: true }
const USB = '/Volumes/USB/Clients'
const DESK = '/Users/me/Desktop'
const DL = '/Users/me/Downloads'
const nord = { spaceId: 's1', name: 'Studio Nord', downloadFolder: USB }
const family = { spaceId: 's2', name: 'Family', downloadFolder: DL }

// Feeds the decision one state after another, as the bridge's effect sees them, and returns what
// it did at each step: the action's kind, or '-' for nothing.
function replay(steps) {
  let previous = null
  return steps.map(({ spaces, unavailable, faultSeq = 0 }) => {
    const { state, action } = folderToastDecision({ previous, spaces, unavailable, faultSeq, host: HOST })
    previous = state
    return action ? action.kind : '-'
  })
}

test('a space\'s folder going away shows the toast once, naming the space and its folder', (t) => {
  const { action } = folderToastDecision({ previous: null, spaces: [nord, family], unavailable: [USB], faultSeq: 0, host: HOST })
  t.alike(action, { kind: 'show', spaceId: 's1', space: 'Studio Nord', more: 0, folder: USB })
  t.alike(replay([
    { spaces: [nord, family], unavailable: [USB] },
    { spaces: [nord, family], unavailable: [USB] },
    { spaces: [nord, family], unavailable: [USB], faultSeq: 1 },
  ]), ['show', '-', 'show'], 'a re-probe of the same fault is silent; a failed download names it again')
})

test('a healthy session never toasts, and a recent folder that is no space\'s never does', (t) => {
  t.alike(replay([
    { spaces: [], unavailable: [] },
    { spaces: [nord, family], unavailable: [] },
    { spaces: [{ ...nord, downloadFolder: DESK }, family], unavailable: [USB] },
  ]), ['-', '-', '-'])
})

test('the folder coming back says so', (t) => {
  t.alike(replay([
    { spaces: [nord, family], unavailable: [USB] },
    { spaces: [nord, family], unavailable: [] },
  ]), ['show', 'restored'])
})

test('several spaces on one disk name the first and count the rest; the next takes over when it moves', (t) => {
  const press = { spaceId: 's3', name: 'Press', downloadFolder: '/Volumes/USB/Press' }
  const { action } = folderToastDecision({ previous: null, spaces: [nord, press], unavailable: [USB, press.downloadFolder], faultSeq: 0, host: HOST })
  t.alike(action, { kind: 'show', spaceId: 's1', space: 'Studio Nord', more: 1, folder: USB })
  t.alike(replay([
    { spaces: [nord, press], unavailable: [USB, press.downloadFolder] },
    { spaces: [{ ...nord, downloadFolder: DESK }, press], unavailable: [USB, press.downloadFolder] },
  ]), ['show', 'show'])
})

// REGRESSION (FIX-DLTO-R14: moving the space off an unplugged folder, or leaving it, replaced the
// sticky error with "Download folder is available again" while the drive was still out).
test('REGRESSION (FIX-DLTO-R14: no space on the folder any more, folder still gone: the toast goes, nothing came back)', (t) => {
  t.alike(replay([
    { spaces: [nord, family], unavailable: [USB] },
    { spaces: [{ ...nord, downloadFolder: DESK }, family], unavailable: [USB] },
    { spaces: [{ ...nord, downloadFolder: DESK }, family], unavailable: [USB] },
  ]), ['show', 'dismiss', '-'], 'the space moved away')
  t.alike(replay([
    { spaces: [nord, family], unavailable: [USB] },
    { spaces: [family], unavailable: [USB] },
  ]), ['show', 'dismiss'], 'the space was left')
})

// REGRESSION (FIX-DLTO-R14: the toast named a space still waiting for approval, and its action
// opened a screen with no way to change the folder).
test('REGRESSION (FIX-DLTO-R14: a space waiting for approval is never named)', (t) => {
  const waiting = { spaceId: 's0', name: 'Waiting', downloadFolder: USB, status: 'pending' }
  const { action } = folderToastDecision({ previous: null, spaces: [waiting, nord], unavailable: [USB], faultSeq: 0, host: HOST })
  t.alike(action, { kind: 'show', spaceId: 's1', space: 'Studio Nord', more: 0, folder: USB }, 'the joined space is named, with no count for the waiting one')
  t.alike(replay([
    { spaces: [waiting], unavailable: [USB] },
  ]), ['-'], 'a waiting space alone raises nothing')
})
