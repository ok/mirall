import test from 'brittle'
import {
  statusToBadge,
  badgeStyle,
  roleBadge,
} from '../../src/renderer/model/status-badge.js'
import { FILE_STATUSES } from '../../src/shared/contract/statuses.js'

const ROLES = ['mine', 'browse', 'mirrored']

const ALLOWED_BG = [
  'bg-success', 'bg-info', 'bg-warning', 'bg-error-container', 'bg-surface-container-highest',
]

function allAppearances() {
  return [
    ...FILE_STATUSES.flatMap((s) => [
      badgeStyle(statusToBadge(s, true)),
      badgeStyle(statusToBadge(s, false)),
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
  t.ok(badgeStyle(statusToBadge('downloaded', false)).classes.includes('bg-success'))

  const own = badgeStyle(statusToBadge('synced', true))
  t.ok(own.classes.includes('bg-success'), 'own file is green (on your device)')
  t.absent(own.classes.includes('bg-secondary-fixed'), 'own file no longer uses the peach pill')
  t.is(own.labelKey, 'status.mine')

  const peerMirrored = badgeStyle(statusToBadge('synced', false))
  t.ok(peerMirrored.classes.includes('bg-success'), 'a peer\'s mirrored-to-disk file is green/on-device')
  t.is(peerMirrored.labelKey, 'status.downloaded')
})

test('ownership changes only the synced pill: every other status maps alike for both', (t) => {
  for (const s of FILE_STATUSES) {
    if (s === 'synced') continue
    t.is(statusToBadge(s, true), statusToBadge(s, false), `${s} ignores ownership`)
  }
  t.is(statusToBadge('synced', true), 'mine')
  t.is(statusToBadge('synced', false), 'on-device')
})

test('BLUE: every in-transfer state is blue and off the rose token', (t) => {
  for (const s of ['downloading', 'preparing', 'publishing']) {
    const c = badgeStyle(statusToBadge(s, false)).classes
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
  t.is(badgeStyle(statusToBadge('preparing', false)).classes, 'bg-info text-accent animate-pulse')
  t.is(badgeStyle(statusToBadge('downloading', false)).classes, 'bg-info text-accent')
  t.ok(badgeStyle(statusToBadge('downloaded', false)).classes.includes('bg-success'))
  for (const s of ['preparing', 'downloading', 'downloaded']) {
    t.absent(badgeStyle(statusToBadge(s, false)).classes.includes('bg-error-container'), `${s} is not the error pill`)
  }
})

// REGRESSION (FIX-PREP2: a folder share had no way to say "I am adding this" — the owner's own
// freshly-added file was forced through the CONSUMER's token and read "Preparing…", the same pill
// a member waiting on someone else's hash gets.)
test('REGRESSION (FIX-PREP2): the owner adding a folder file reads "Adding", not "Preparing…"', (t) => {
  t.is(badgeStyle(statusToBadge('publishing', true)).labelKey, 'status.publishing')
  t.is(badgeStyle(statusToBadge('preparing', false)).labelKey, 'status.preparing',
    'a member waiting on the owner keeps the preparing pill')
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
  t.ok(badgeStyle(statusToBadge('paused-interrupted', false)).classes.includes('bg-warning'))
  t.ok(roleBadge('mirrored', { paused: true }).classes.includes('bg-warning'))
  t.is(roleBadge('mirrored', { paused: true }).labelKey, 'folder.paused')
})

test('RED: error-container is reserved for the failed status only', (t) => {
  for (const a of allAppearances()) {
    if (a.classes.includes('bg-error-container')) t.is(a.labelKey, 'status.failed')
  }
})

test('unavailable reads "Not available"', (t) => {
  t.is(badgeStyle(statusToBadge('unavailable', false)).labelKey, 'status.unavailable')
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
  for (const s of FILE_STATUSES) {
    t.ok(badgeStyle(statusToBadge(s, false)).labelKey.length > 0)
    t.ok(badgeStyle(statusToBadge(s, true)).labelKey.length > 0)
  }
  for (const r of ROLES) t.ok(roleBadge(r).labelKey.length > 0)
})

test('R4: the indeterminate inbound states (preparing, verifying) pulse; downloading does not', (t) => {
  t.ok(badgeStyle(statusToBadge('preparing', false)).classes.includes('animate-pulse'))
  t.ok(badgeStyle(statusToBadge('verifying', false)).classes.includes('animate-pulse'))
  t.absent(badgeStyle(statusToBadge('downloading', false)).classes.includes('animate-pulse'))
})

test('exhaustiveness: every enum value maps to a defined badge appearance', (t) => {
  for (const s of FILE_STATUSES) {
    for (const isOwn of [true, false]) {
      const bs = statusToBadge(s, isOwn)
      t.ok(bs, `FileStatus "${s}" maps to a badge status`)
      t.ok(badgeStyle(bs), `badge status "${bs}" has an appearance`)
    }
  }
})

test('YELLOW: a copy edited on this device is amber, labelled apart from the synced pill', (t) => {
  for (const style of [badgeStyle(statusToBadge('modified', false)), badgeStyle(statusToBadge('modified', true))]) {
    t.ok(style.classes.includes('bg-warning'), 'needs attention')
    t.is(style.labelKey, 'status.modified')
  }
  t.not(badgeStyle(statusToBadge('modified', false)).classes, badgeStyle(statusToBadge('synced', false)).classes)
})

test('NEUTRAL: a queued add is the neutral "Queued" chip, not the blue in-transfer one', (t) => {
  const queued = badgeStyle(statusToBadge('queued', false))
  t.is(queued.labelKey, 'status.queued')
  t.ok(queued.classes.includes('bg-surface-container-highest'), 'nothing is moving yet')
  t.absent(queued.classes.includes('animate-pulse'))
})

test('WAITING: a parked download wears the passive pill and names its own label', (t) => {
  const waiting = badgeStyle(statusToBadge('waiting', false))
  t.is(waiting.labelKey, 'status.waiting')
  t.ok(waiting.classes.includes('bg-surface-container-highest'), 'passive, not the busy blue: nothing is moving')
})
