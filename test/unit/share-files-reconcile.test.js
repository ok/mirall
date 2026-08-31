import test from 'brittle'
import { reconcileFiles } from '../../src/renderer/shareFilesReconcile.js'

const row = (relPath, extra = {}) => ({ relPath, size: 1, hash: 'h', mtime: 0, status: 'remote', ...extra })

// REGRESSION (FIX-130: a peer-catalog read can transiently return empty/partial while the owner
// indexes a large folder; a whole-list replace then blanked or shrank the view. The worker tags
// each read complete:true|false and reconcileFiles must never blank/shrink on an incomplete one.)
test('REGRESSION (FIX-130): an incomplete peer-catalog read must not blank or shrink the folder listing', (t) => {
  const prev = [row('a'), row('b'), row('c')]

  t.alike(reconcileFiles(prev, [row('a')], { complete: true }).map((f) => f.relPath), ['a'], 'complete → wholesale adopt (incl. removals)')

  t.is(reconcileFiles(prev, [], { complete: false }), prev, 'partial empty → keep prev (no blank)')

  t.alike(reconcileFiles(prev, [row('a')], { complete: false }).map((f) => f.relPath), ['a', 'b', 'c'], 'partial fewer → never shrink')

  const merged = reconcileFiles(prev, [row('b', { status: 'downloaded' }), row('d')], { complete: false })
  t.alike(merged.map((f) => f.relPath), ['a', 'b', 'c', 'd'], 'partial → adds new, sorted by relPath')
  t.is(merged.find((f) => f.relPath === 'b').status, 'downloaded', 'fresh row value wins on merge')
})

test('an unchanged incomplete read returns the prev reference (no needless re-render)', (t) => {
  const prev = [row('a'), row('b'), row('c')]
  t.is(reconcileFiles(prev, [row('a'), row('b'), row('c')], { complete: false }), prev, 'identical partial → same reference')
  t.is(reconcileFiles(prev, [row('a'), row('c')], { complete: false }), prev, 'subset partial with identical values → same reference')
})

// ── Row identity ──────────────────────────────────────────────────────────────
// reconcileFiles is what lets a memoized row skip a re-render, so identity is the assertion here,
// not deep equality: `t.alike` passes on exactly the bug these cover. `t.is` is Object.is.

// REGRESSION (FIX-R04-7: `if (complete) return next` handed EVERY row a new object on every
// complete read — the ordinary owner-side listing — so React.memo on the row could never bail.)
test('REGRESSION (FIX-R04-7): a complete read must not replace unchanged row objects', (t) => {
  const prev = [row('a.txt'), row('b.txt')]
  const next = [row('a.txt'), row('b.txt', { size: 99 })]
  const out = reconcileFiles(prev, next, { complete: true })

  t.is(out[0], prev[0], 'the unchanged row keeps its identity')
  t.not(out[1], prev[1], 'the changed row does not')
  t.is(out[1].size, 99, 'and carries the fresh content')
})

// REGRESSION (FIX-R04-7: the partial branch pushed `b` unconditionally, so one changed row gave
// every OTHER row a new object too.)
test('REGRESSION (FIX-R04-7): one changed row must not re-identify the others', (t) => {
  const prev = [row('a.txt'), row('b.txt'), row('c.txt')]
  const next = [row('a.txt'), row('b.txt', { status: 'downloaded' }), row('c.txt')]
  const out = reconcileFiles(prev, next, { complete: false })

  t.is(out[0], prev[0], 'a.txt keeps its identity')
  t.not(out[1], prev[1], 'b.txt, which changed, does not')
  t.is(out[2], prev[2], 'c.txt keeps its identity')
})

test('an unchanged complete read returns the previous ARRAY', (t) => {
  const prev = [row('a.txt'), row('b.txt')]
  t.is(reconcileFiles(prev, [row('a.txt'), row('b.txt')], { complete: true }), prev, 'identical complete → same reference')
})

test('a complete read against an empty prev adopts next wholesale', (t) => {
  const next = [row('a.txt')]
  t.is(reconcileFiles([], next, { complete: true }), next, 'nothing to adopt identity from')
})

// The authoritative-read contract the `complete` flag exists for. An over-clever identity walk
// resurrects a row that is absent from `next`; this is the test that catches it.
test('a complete read still applies removals, additions and content updates', (t) => {
  const prev = [row('a.txt'), row('b.txt'), row('c.txt')]

  const removed = reconcileFiles(prev, [row('a.txt'), row('c.txt')], { complete: true })
  t.alike(removed.map((f) => f.relPath), ['a.txt', 'c.txt'], 'b.txt is gone')
  t.is(removed[0], prev[0], 'a.txt survives the removal with its identity')
  t.is(removed[1], prev[2], 'c.txt does too')

  const added = reconcileFiles(prev, [row('a.txt'), row('b.txt'), row('b2.txt'), row('c.txt')], { complete: true })
  t.alike(added.map((f) => f.relPath), ['a.txt', 'b.txt', 'b2.txt', 'c.txt'], 'b2.txt is inserted in order')
  t.is(added[3], prev[2], 'c.txt keeps its identity across the insertion')

  const trailing = reconcileFiles(prev, [row('a.txt')], { complete: true })
  t.alike(trailing.map((f) => f.relPath), ['a.txt'], 'a trailing removal applies')
})

// REGRESSION (FIX-R04-7: sameRow compared five fields; toEntry produces four MORE that the row
// renders — verified (the check), errorCode (a role="alert" line), transferId (what pause/cancel
// act on) and pendingBytes (the paused byte count). A row changing only one of them was "unchanged",
// so it kept its previous object AND its previous values, and the update was dropped for good.)
test('REGRESSION (FIX-R04-7): every field toEntry produces counts as a change', (t) => {
  const fields = {
    size: 2,
    hash: 'h2',
    mtime: 1,
    status: 'downloading',
    localPath: '/tmp/a.txt',
    verified: true,
    pendingBytes: 512,
    errorCode: 'EPEER',
    transferId: 'tx-2',
  }
  const base = { relPath: 'a.txt', size: 1, hash: 'h', mtime: 0, status: 'remote' }

  for (const [field, value] of Object.entries(fields)) {
    const prev = [{ ...base }]
    const next = [{ ...base, [field]: value }]

    const complete = reconcileFiles(prev, next, { complete: true })
    t.not(complete[0], prev[0], `complete: a changed ${field} yields a fresh row`)
    t.is(complete[0][field], value, `complete: the fresh ${field} lands`)

    const partial = reconcileFiles(prev, next, { complete: false })
    t.not(partial, prev, `partial: a changed ${field} is not discarded as unchanged`)
    t.is(partial[0][field], value, `partial: the fresh ${field} lands`)
  }
})

// 'publishing' joined SHARE_FILE_STATUS with the indexing-vs-downloading split; it is a value in
// the `status` field sameRow already compares, and must move a row like any other status.
test('a publishing→downloading transition is a change', (t) => {
  const prev = [row('a.txt', { status: 'publishing' })]
  const out = reconcileFiles(prev, [row('a.txt', { status: 'downloading' })], { complete: true })
  t.not(out[0], prev[0], 'the row is re-identified')
  t.is(out[0].status, 'downloading', 'and carries the new status')
})

// The safety property behind adoptIdentity's two-pointer walk. Both lists are sorted by relPath by
// contract (the catalog read-stream is key-ordered), and a reordering that is not an add or remove
// therefore cannot occur — but if that contract were ever broken, the result must still be exactly
// next's CONTENT. `out` is built one slot per next entry, so bad ordering costs identity adoption
// and nothing else.
test('a complete read with an out-of-order next still yields exactly next content', (t) => {
  const prev = [row('a.txt'), row('b.txt'), row('c.txt')]
  const next = [row('c.txt'), row('a.txt'), row('b.txt', { size: 42 })]
  const out = reconcileFiles(prev, next, { complete: true })

  t.alike(out.map((f) => f.relPath), ['c.txt', 'a.txt', 'b.txt'], 'order and membership follow next')
  t.is(out[2].size, 42, 'content follows next')
})
