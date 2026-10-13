import test from 'brittle'
import { readFileSync } from 'fs'
import { fileRowActions } from '../../src/renderer/model/file-row-action.js'
import { FILE_STATUSES } from '../../src/shared/contract/statuses.js'

const LOOSE = { manualControls: true, ownerFileVerbs: true }
const BROWSE = { manualControls: true, ownerFileVerbs: false }
const MIRROR = { manualControls: false, ownerFileVerbs: false }
const KINDS = { loose: LOOSE, browse: BROWSE, mirror: MIRROR }

const run = (ctx) => (status, { own = false, transfer = false } = {}) =>
  fileRowActions({ status, transferId: transfer ? 't1' : undefined }, { ...ctx, isOwn: own })
const loose = run(LOOSE)
const browse = run(BROWSE)
const mirror = run(MIRROR)
// [secondary, primary], left to right as the strip renders them.
const ids = (r) => [r.secondary?.id ?? null, r.primary?.id ?? null]

test('REGRESSION (FIX-MIRROR-CONTROLS): a mirrored remote file exposes NO download action', (t) => {
  t.alike(ids(mirror('remote')), [null, null], 'no Download button on a mirrored not-yet-synced file')
})

test('REGRESSION (FIX-MIRROR-CONTROLS): a mirrored in-flight file exposes NO pause/cancel', (t) => {
  t.alike(ids(mirror('downloading', { transfer: true })), [null, 'busy'], 'a syncing mirror row is passive, not pause/cancel')
})

test('REGRESSION (FIX-MIRROR-CONTROLS): a mirrored interrupted/unavailable file exposes NO controls', (t) => {
  t.alike(ids(mirror('paused-interrupted', { transfer: true })), [null, null])
  t.alike(ids(mirror('paused-offline', { transfer: true })), [null, null])
  t.alike(ids(mirror('unavailable')), [null, null])
})

test('mirrored on-disk files keep Reveal', (t) => {
  t.alike(ids(mirror('synced')), [null, 'reveal'])
  t.alike(ids(mirror('downloaded')), [null, 'reveal'])
})

test('owner preparing indicator (#193) is preserved as a passive busy state', (t) => {
  t.alike(ids(mirror('preparing')), [null, 'busy'])
  t.is(mirror('preparing').primary.labelKey, 'file.preparing')
  const indexing = mirror('publishing', { own: true })
  t.alike(ids(indexing), [null, 'busy'], "the owner's own indexing folder row is busy, not actionable")
  t.is(indexing.primary.labelKey, 'status.publishing')
  t.alike(ids(browse('publishing', { own: true })), [null, 'busy'], 'a folder file has no per-file cancel-publish')
})

test('verifying behaves like downloading — pause/cancel when controllable, busy otherwise', (t) => {
  t.alike(ids(browse('verifying', { transfer: true })), ['cancel', 'pause'], 'a verifying row stays pausable mid-verify')
  t.alike(ids(browse('verifying')), [null, 'busy'])
  t.alike(ids(mirror('verifying', { transfer: true })), [null, 'busy'], 'a mirror verify row is passive')
})

test('browse folders keep the full manual control set, primary right and destructive left', (t) => {
  t.alike(ids(browse('remote')), [null, 'download'])
  t.alike(ids(browse('downloading', { transfer: true })), ['cancel', 'pause'])
  t.alike(ids(browse('downloading')), [null, 'busy'])
  t.alike(ids(browse('paused-interrupted', { transfer: true })), ['discard', 'resume'])
  t.alike(ids(browse('paused-interrupted')), [null, 'resume'])
  t.alike(ids(browse('paused-offline', { transfer: true })), [null, 'discard'])
  t.alike(ids(browse('paused-offline')), [null, null])
  t.alike(ids(browse('unavailable')), [null, 'download-unavailable'])
  t.ok(browse('unavailable').primary.disabled, 'the owner-offline download is disabled')
  t.alike(ids(browse('error', { transfer: true })), ['dismiss', 'retry'])
  t.alike(ids(browse('synced', { own: true })), [null, 'reveal'], 'an own folder file cannot be unshared on its own')
  t.alike(ids(browse('downloaded')), [null, 'reveal'])
  t.alike(ids(browse('preparing')), [null, 'busy'])
})

test('an edited copy offers Reveal on every kind of row, so the edit can be rescued', (t) => {
  t.alike(ids(mirror('modified')), [null, 'reveal'])
  t.alike(ids(browse('modified')), [null, 'reveal'])
  t.alike(ids(loose('modified')), [null, 'reveal'])
})

test('loose rows: own files can be withdrawn, everything else matches a browsed folder', (t) => {
  t.alike(ids(loose('synced', { own: true })), ['unshare', 'reveal'])
  t.alike(ids(loose('synced')), [null, 'reveal'], 'a synced copy of a peer file is not ours to unshare')
  t.alike(ids(loose('downloaded', { own: true })), [null, 'reveal'])
  t.alike(ids(loose('publishing', { own: true })), [null, 'cancel-publish'])
  t.alike(ids(loose('queued', { own: true })), [null, 'cancel-publish'])
  t.alike(ids(loose('preparing')), [null, 'busy'], 'a peer file the owner is still hashing shows the busy status')
  t.alike(ids(loose('unavailable')), [null, 'download-unavailable'])
})

// The whole table, one row per status × context: [secondary, primary] ids.
const EXPECTED = {
  remote: { loose: [null, 'download'], browse: [null, 'download'], mirror: [null, null] },
  preparing: { loose: [null, 'busy'], browse: [null, 'busy'], mirror: [null, 'busy'] },
  downloading: { loose: ['cancel', 'pause'], browse: ['cancel', 'pause'], mirror: [null, 'busy'] },
  verifying: { loose: ['cancel', 'pause'], browse: ['cancel', 'pause'], mirror: [null, 'busy'] },
  queued: { loose: [null, 'cancel-publish'], browse: [null, 'busy'], mirror: [null, 'busy'] },
  publishing: { loose: [null, 'cancel-publish'], browse: [null, 'busy'], mirror: [null, 'busy'] },
  downloaded: { loose: [null, 'reveal'], browse: [null, 'reveal'], mirror: [null, 'reveal'] },
  synced: { loose: ['unshare', 'reveal'], browse: [null, 'reveal'], mirror: [null, 'reveal'] },
  modified: { loose: [null, 'reveal'], browse: [null, 'reveal'], mirror: [null, 'reveal'] },
  unavailable: { loose: [null, 'download-unavailable'], browse: [null, 'download-unavailable'], mirror: [null, null] },
  'paused-interrupted': { loose: ['discard', 'resume'], browse: ['discard', 'resume'], mirror: [null, null] },
  'paused-offline': { loose: [null, 'discard'], browse: [null, 'discard'], mirror: [null, null] },
  error: { loose: ['dismiss', 'retry'], browse: ['dismiss', 'retry'], mirror: [null, null] },
}

test('the table: every file status, for an own row with a transfer, on each kind of row', (t) => {
  t.alike(Object.keys(EXPECTED).sort(), [...FILE_STATUSES].sort(), 'the table covers every file status')
  for (const status of FILE_STATUSES) {
    for (const [kind, ctx] of Object.entries(KINDS)) {
      t.alike(ids(run(ctx)(status, { own: true, transfer: true })), EXPECTED[status][kind], `${status} on a ${kind} row`)
    }
  }
})

const product = () => FILE_STATUSES.flatMap((status) => Object.entries(KINDS).flatMap(([kind, ctx]) =>
  [false, true].flatMap((own) => [false, true].map((transfer) => ({
    status, kind, ctx, own, transfer, actions: run(ctx)(status, { own, transfer }),
  })))))
const both = (r) => [r.primary, r.secondary].filter(Boolean)

test('only a withdraw, a cancel, a discard or a dismiss is destructive, and every close/delete is', (t) => {
  const DANGER = new Set(['unshare', 'cancel', 'cancel-publish', 'discard', 'dismiss'])
  for (const c of product()) {
    for (const a of both(c.actions)) {
      t.is(a.tone === 'danger', DANGER.has(a.id), `${c.status}/${c.kind}: ${a.id} tone`)
      if (a.icon === 'close' || a.icon === 'delete') t.is(a.tone, 'danger', `${c.status}/${c.kind}: ${a.id} icon is destructive`)
    }
  }
})

test('a secondary never appears without a primary', (t) => {
  for (const c of product()) t.ok(c.actions.secondary === null || c.actions.primary !== null, `${c.status}/${c.kind}`)
})

test('unshare appears only on an own row, and either withdraw only where one file can be withdrawn', (t) => {
  for (const c of product()) {
    const ids = both(c.actions).map((a) => a.id)
    if (ids.includes('unshare')) t.ok(c.own && c.ctx.ownerFileVerbs, `${c.status}/${c.kind}/own=${c.own}: unshare`)
    if (ids.includes('cancel-publish')) t.ok(c.ctx.ownerFileVerbs, `${c.status}/${c.kind}: cancel-publish`)
  }
})

test('REGRESSION (FIX-B4-2: an own add could not be cancelled while the profile that marks it own was still loading)', (t) => {
  t.alike(ids(loose('publishing')), [null, 'cancel-publish'], 'a publishing loose row offers Cancel before isOwn is known')
  t.alike(ids(loose('queued')), [null, 'cancel-publish'], 'so does a queued one')
})

// Which name, icon and tone each action carries: the AX name a scenario and a screen reader find
// it by, so a destructive button can never wear another verb's label.
const SPEC = {
  reveal: { labelKey: 'file.revealInFolder', icon: 'folder_open', tone: 'default' },
  unshare: { labelKey: 'file.unshare', icon: 'delete', tone: 'danger' },
  download: { labelKey: 'file.download', icon: 'download', tone: 'default' },
  'download-unavailable': { labelKey: 'file.downloadUnavailable', icon: 'download', tone: 'default' },
  pause: { labelKey: 'file.pause', icon: 'pause', tone: 'default' },
  cancel: { labelKey: 'file.cancel', icon: 'close', tone: 'danger' },
  'cancel-publish': { labelKey: 'file.cancel', icon: 'close', tone: 'danger' },
  resume: { labelKey: 'file.resume', icon: 'play_arrow', tone: 'default' },
  discard: { labelKey: 'file.discardPartial', icon: 'close', tone: 'danger' },
  retry: { labelKey: 'file.retry', icon: 'refresh', tone: 'default' },
  dismiss: { labelKey: 'file.dismiss', icon: 'close', tone: 'danger' },
}
const BUSY_LABELS = new Set(['file.preparing', 'file.syncing', 'status.publishing', 'status.queued'])

test('every action carries its own name, icon and tone', (t) => {
  const seen = new Set()
  for (const c of product()) {
    for (const a of both(c.actions)) {
      seen.add(a.id)
      if (a.id === 'busy') {
        t.is(a.icon, 'update', `${c.status}/${c.kind}: busy icon`)
        t.ok(BUSY_LABELS.has(a.labelKey), `${c.status}/${c.kind}: busy label ${a.labelKey}`)
        continue
      }
      t.alike({ labelKey: a.labelKey, icon: a.icon, tone: a.tone }, SPEC[a.id], `${c.status}/${c.kind}: ${a.id}`)
    }
  }
  t.alike([...seen].sort(), [...Object.keys(SPEC), 'busy'].sort(), 'every action id is reached')
})

test('a self-syncing row offers nothing but Reveal or a busy status', (t) => {
  for (const c of product().filter((x) => !x.ctx.manualControls)) {
    for (const a of both(c.actions)) t.ok(a.id === 'reveal' || a.id === 'busy', `${c.status}: ${a.id}`)
  }
})

test('every label key resolves in the en locale', (t) => {
  const en = JSON.parse(readFileSync(new URL('../../src/renderer/locales/en/common.json', import.meta.url), 'utf8'))
  const resolve = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en)
  const keys = new Set(product().flatMap((c) => both(c.actions).map((a) => a.labelKey)))
  for (const key of keys) t.is(typeof resolve(key), 'string', key)
})

test('REGRESSION (FIX-B4-0: the loose Discard Partial and Dismiss were neutral while the folder\'s were destructive)', (t) => {
  for (const ctx of [LOOSE, BROWSE]) {
    const kind = ctx === LOOSE ? 'loose' : 'folder'
    t.is(run(ctx)('paused-interrupted', { transfer: true }).secondary.tone, 'danger', `${kind} Discard Partial`)
    t.is(run(ctx)('paused-offline', { transfer: true }).primary.tone, 'danger', `${kind} lone Discard Partial`)
    t.is(run(ctx)('error', { transfer: true }).secondary.tone, 'danger', `${kind} Dismiss`)
  }
})
