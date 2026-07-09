import test from 'brittle'
import {
  fileStatusToBadge,
  shareFileStatusToBadge,
  badgeStyle,
  roleBadge,
} from '../../src/renderer/statusBadge.js'

const FILE_STATUSES = [
  'mine', 'downloaded', 'remote', 'preparing', 'downloading', 'verifying', 'publishing',
  'paused-interrupted', 'paused-offline', 'unavailable', 'error',
]
const SHARE_STATUSES = [
  'remote', 'preparing', 'downloading', 'verifying', 'downloaded', 'synced',
  'unavailable', 'paused-interrupted', 'paused-offline',
]
const ROLES = ['mine', 'browse', 'mirrored']

const ALLOWED_BG = [
  'bg-success', 'bg-info', 'bg-warning', 'bg-error-container', 'bg-surface-container-highest',
]

function allAppearances () {
  return [
    ...FILE_STATUSES.map((s) => badgeStyle(fileStatusToBadge(s))),
    ...SHARE_STATUSES.flatMap((s) => [
      badgeStyle(shareFileStatusToBadge(s, true)),
      badgeStyle(shareFileStatusToBadge(s, false)),
    ]),
    ...ROLES.map((r) => roleBadge(r)),
    roleBadge('mirrored', { paused: true }),
    roleBadge('mine', { missing: true }),
  ]
}

test('PALETTE: every pill background is one of the five fixed semantic colors', (t) => {
  for (const a of allAppearances()) {
    const bg = a.classes.split(' ').find((c) => c.startsWith('bg-'))
    t.ok(ALLOWED_BG.includes(bg), `"${bg}" is in the fixed palette`)
  }
})

test('GREEN: the "on your device" family is green; an owner\'s own file included', (t) => {
  t.ok(badgeStyle(fileStatusToBadge('mine')).classes.includes('bg-success'))
  t.ok(badgeStyle(fileStatusToBadge('downloaded')).classes.includes('bg-success'))

  const own = badgeStyle(shareFileStatusToBadge('synced', true))
  t.ok(own.classes.includes('bg-success'), 'own folder file is green (on your device)')
  t.absent(own.classes.includes('bg-secondary-fixed'), 'own file no longer uses the peach pill')
  t.is(own.labelKey, 'status.mine')

  const peerMirrored = badgeStyle(shareFileStatusToBadge('synced', false))
  t.ok(peerMirrored.classes.includes('bg-success'), 'a peer\'s mirrored-to-disk file is green/on-device')
  t.is(peerMirrored.labelKey, 'status.downloaded')
})

test('GREEN: the same concept is the same color across file contexts', (t) => {
  const fileCardMine = badgeStyle(fileStatusToBadge('mine'))
  const folderViewMine = badgeStyle(shareFileStatusToBadge('synced', true))
  t.is(fileCardMine.classes, folderViewMine.classes, 'mine is green in both the space file list and the folder view')
})

test('BLUE: every in-transfer state is blue and off the rose token', (t) => {
  for (const s of ['downloading', 'preparing', 'publishing']) {
    const c = badgeStyle(fileStatusToBadge(s)).classes
    t.ok(c.includes('bg-info'), `${s} is blue`)
    t.absent(c.includes('tertiary-fixed'), `${s} no longer rose`)
  }
})

// Palette CONTRACT the supersede→restart arc relies on (the restart cycles the pill
// preparing → downloading → downloaded by zeroing bytes, never surfacing an error).
// This guards only the status→colour mapping — the runtime reset behaviour is asserted
// at the flow (transfer-superseded then transfer-complete) and frontend (pill sequence)
// layers, where it is observable. If anyone recolours these, the restart UX regresses.
test('CONTRACT: preparing/downloading are blue, downloaded is green, and none are red', (t) => {
  t.is(badgeStyle(fileStatusToBadge('preparing')).classes, 'bg-info text-accent animate-pulse')
  t.is(badgeStyle(fileStatusToBadge('downloading')).classes, 'bg-info text-accent')
  t.ok(badgeStyle(fileStatusToBadge('downloaded')).classes.includes('bg-success'))
  for (const s of ['preparing', 'downloading', 'downloaded']) {
    t.absent(badgeStyle(fileStatusToBadge(s)).classes.includes('bg-error-container'), `${s} is not the error pill`)
  }
})

test('NEUTRAL: all three folder roles are the neutral chip', (t) => {
  for (const r of ROLES) {
    const c = roleBadge(r).classes
    t.ok(c.includes('bg-surface-container-highest'), `${r} role is neutral`)
    t.absent(/secondary-fixed|primary-fixed/.test(c), `${r} role drops the old hue`)
  }
})

test('YELLOW: a missing source folder is attention (amber), not error', (t) => {
  const missing = roleBadge('mine', { missing: true })
  t.ok(missing.classes.includes('bg-warning'))
  t.ok(missing.classes.includes('text-on-warning'))
  t.absent(missing.classes.includes('bg-error-container'))
  t.is(missing.labelKey, 'share.mountPointGone')
})

test('YELLOW: a paused download and a paused mirror folder are both amber', (t) => {
  t.ok(badgeStyle(fileStatusToBadge('paused-interrupted')).classes.includes('bg-warning'))
  t.ok(badgeStyle(shareFileStatusToBadge('paused-interrupted', false)).classes.includes('bg-warning'))
  t.ok(roleBadge('mirrored', { paused: true }).classes.includes('bg-warning'))
  t.is(roleBadge('mirrored', { paused: true }).labelKey, 'folder.paused')
})

test('RED: error-container is reserved for the failed status only', (t) => {
  for (const a of allAppearances()) {
    if (a.classes.includes('bg-error-container')) t.is(a.labelKey, 'status.failed')
  }
})

test('unavailable reads "Not available" in both file contexts', (t) => {
  t.is(badgeStyle(fileStatusToBadge('unavailable')).labelKey, 'status.unavailable')
  t.is(badgeStyle(shareFileStatusToBadge('unavailable', false)).labelKey, 'status.unavailable')
})

test('R1: every pill uses text-accent unless on bg-warning (then text-on-warning); never text-on-*-fixed', (t) => {
  for (const a of allAppearances()) {
    t.absent(/text-on-\w+-fixed/.test(a.classes), `no on-*-fixed text token in "${a.classes}"`)
    if (a.classes.includes('bg-warning')) {
      t.ok(a.classes.includes('text-on-warning'), `amber pill pairs with on-warning: "${a.classes}"`)
    } else {
      t.ok(a.classes.includes('text-accent'), `non-amber pill uses text-accent: "${a.classes}"`)
    }
  }
})

test('R3: every status and role yields a non-empty label key', (t) => {
  for (const s of FILE_STATUSES) t.ok(badgeStyle(fileStatusToBadge(s)).labelKey.length > 0)
  for (const s of SHARE_STATUSES) t.ok(badgeStyle(shareFileStatusToBadge(s, false)).labelKey.length > 0)
  for (const r of ROLES) t.ok(roleBadge(r).labelKey.length > 0)
})

test('R4: the indeterminate inbound states (preparing, verifying) pulse; downloading does not', (t) => {
  t.ok(badgeStyle(shareFileStatusToBadge('preparing', false)).classes.includes('animate-pulse'))
  t.ok(badgeStyle(shareFileStatusToBadge('verifying', false)).classes.includes('animate-pulse'))
  t.ok(badgeStyle(fileStatusToBadge('verifying')).classes.includes('animate-pulse'))
  t.absent(badgeStyle(shareFileStatusToBadge('downloading', false)).classes.includes('animate-pulse'))
  t.absent(badgeStyle(fileStatusToBadge('downloading')).classes.includes('animate-pulse'))
})

test('exhaustiveness: every enum value maps to a defined badge appearance', (t) => {
  for (const s of FILE_STATUSES) {
    const bs = fileStatusToBadge(s)
    t.ok(bs, `FileStatus "${s}" maps to a badge status`)
    t.ok(badgeStyle(bs), `badge status "${bs}" has an appearance`)
  }
  for (const s of SHARE_STATUSES) {
    const bs = shareFileStatusToBadge(s, false)
    t.ok(bs, `ShareFileStatus "${s}" maps to a badge status`)
    t.ok(badgeStyle(bs), `badge status "${bs}" has an appearance`)
  }
})
