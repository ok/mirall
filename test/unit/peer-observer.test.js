import test from 'brittle'
import {
  classifyProfileChange, classifyCatalogChange, isTransition, readChangesSince,
  stateOf, subjectKey, MAX_OPS_PER_SWEEP, STATE_ON, STATE_OFF,
} from '../../src/shared/audit/peer-observer.js'

const LOOSE = '__loose__'

test('a share record is classified with its space and share ids', (t) => {
  t.alike(classifyProfileChange({ type: 'put', key: 'share/sp1/sh1', value: { name: 'Designs' } }),
    { kind: 'share', spaceId: 'sp1', shareId: 'sh1', removed: false, name: 'Designs' })
})

test('a tombstoned share reads as removed, whether by del or deletedAt', (t) => {
  t.is(classifyProfileChange({ type: 'del', key: 'share/sp1/sh1', value: null }).removed, true)
  t.is(classifyProfileChange({ type: 'put', key: 'share/sp1/sh1', value: { name: 'X', deletedAt: 1 } }).removed, true,
    'a share is tombstoned in place, not deleted — both spellings must read as removed')
})

// REGRESSION (FIX-4): the two record families use DIFFERENT tombstone fields. Reading deletedAt
// on a mirror record made an unmirror look like a fresh mirror — losing the "stopped mirroring"
// event and inventing a duplicate "mirrored" one in its place.
test('REGRESSION (FIX-4): a mirror is tombstoned with unmirroredAt, not deletedAt', (t) => {
  t.is(classifyProfileChange({ type: 'put', key: 'mirror/sp1/sh1', value: { state: 'synced', unmirroredAt: 1 } }).removed, true,
    'an unmirror must not read as a fresh mirror')
  t.is(classifyProfileChange({ type: 'put', key: 'mirror/sp1/sh1', value: { state: 'synced', deletedAt: 1 } }).removed, false,
    'deletedAt is the SHARE convention and carries no meaning on a mirror record')
  t.is(classifyProfileChange({ type: 'put', key: 'share/sp1/sh1', value: { name: 'X', unmirroredAt: 1 } }).removed, false,
    'and the reverse — unmirroredAt carries no meaning on a share record')
})

test('mirror records classify like share records', (t) => {
  const m = classifyProfileChange({ type: 'put', key: 'mirror/sp1/sh1', value: { state: 'syncing' } })
  t.is(m.kind, 'mirror')
  t.is(m.shareId, 'sh1')
  t.is(m.removed, false)
})

test('profile keys that are not content actions are ignored', (t) => {
  for (const key of ['member/sp1', 'approved/sp1/peer', 'displayName', 'avatar', 'caps/folder-shares', 'drive/sp1', 'observed/p/sp1']) {
    t.is(classifyProfileChange({ type: 'put', key, value: {} }), null, key + ' is not a content action')
  }
})

test('malformed share/mirror keys are refused rather than half-parsed', (t) => {
  t.is(classifyProfileChange({ type: 'put', key: 'share/sp1', value: {} }), null, 'missing share id')
  t.is(classifyProfileChange({ type: 'put', key: 'share/sp1/sh1/extra', value: {} }), null, 'too many segments')
  t.is(classifyProfileChange({ type: 'put', key: 'share//sh1', value: {} }), null, 'empty space id')
  t.is(classifyProfileChange({ type: 'put', key: null }), null)
  t.is(classifyProfileChange(null), null)
})

test('a loose catalog entry is classified, and its relPath may contain slashes', (t) => {
  t.alike(classifyCatalogChange({ type: 'put', key: 'file/' + LOOSE + '/report.pdf', value: {} }, LOOSE),
    { shareId: LOOSE, relPath: 'report.pdf', removed: false })
  t.is(classifyCatalogChange({ type: 'put', key: 'file/' + LOOSE + '/a/b/c.txt', value: {} }, LOOSE).relPath, 'a/b/c.txt',
    'only the first segment is the share id')
})

test('folder-share contents are excluded so one mount cannot flood the log', (t) => {
  t.is(classifyCatalogChange({ type: 'put', key: 'file/folder-share-1/deep/nested/file.txt', value: {} }, LOOSE), null,
    'a 5,000-file folder mount is one act, already covered by the share record')
})

test('a tombstoned catalog entry reads as removed', (t) => {
  t.is(classifyCatalogChange({ type: 'del', key: 'file/' + LOOSE + '/x.txt', value: null }, LOOSE).removed, true)
  t.is(classifyCatalogChange({ type: 'put', key: 'file/' + LOOSE + '/x.txt', value: { deletedAt: 1 } }, LOOSE).removed, true)
})

test('malformed catalog keys are refused', (t) => {
  t.is(classifyCatalogChange({ type: 'put', key: 'file/' + LOOSE + '/', value: {} }, LOOSE), null, 'empty relPath')
  t.is(classifyCatalogChange({ type: 'put', key: 'file/onlyshare', value: {} }, LOOSE), null, 'no relPath at all')
  t.is(classifyCatalogChange({ type: 'put', key: 'chunkmap:abc', value: {} }, LOOSE), null)
})

test('a state flip records; a re-write of the same state does not', (t) => {
  // A mirror record is re-put on every sync-state change and again at the peer's boot.
  t.ok(isTransition(null, STATE_ON), 'the first observation of a subject records')
  t.absent(isTransition(STATE_ON, STATE_ON), 'a re-write of the same state is not an act')
  t.ok(isTransition(STATE_ON, STATE_OFF), 'stopping records')
  t.ok(isTransition(STATE_OFF, STATE_ON), 'and starting again records')
})

test('stateOf maps removal onto the stored state', (t) => {
  t.is(stateOf(false), STATE_ON)
  t.is(stateOf(true), STATE_OFF)
})

test('subject keys never collide across peer, space or subject', (t) => {
  const keys = new Set([
    subjectKey('file', 'bob', 'sp1', 'a.txt'),
    subjectKey('file', 'bob', 'sp1', 'b.txt'),
    subjectKey('file', 'carol', 'sp1', 'a.txt'),
    subjectKey('file', 'bob', 'sp2', 'a.txt'),
    subjectKey('mirror', 'bob', 'sp1', 'a.txt'),
  ])
  t.is(keys.size, 5)
})

test('readChangesSince returns nothing when already at the head', async (t) => {
  const bee = { version: 7, createHistoryStream: () => { throw new Error('must not read') } }
  t.alike(await readChangesSince(bee, 7), { version: 7, nodes: [], skipped: false })
  t.alike(await readChangesSince(bee, 9), { version: 7, nodes: [], skipped: false }, 'a watermark ahead of the head is inert')
})

test('readChangesSince refuses to replay an unbounded backlog', async (t) => {
  const many = Array.from({ length: MAX_OPS_PER_SWEEP + 50 }, (_, i) => ({ type: 'put', key: 'share/sp1/s' + i, value: {} }))
  const bee = { version: 9999, createHistoryStream: () => many[Symbol.iterator]() }
  const res = await readChangesSince(bee, 1)
  t.is(res.nodes.length, MAX_OPS_PER_SWEEP, 'capped')
  t.ok(res.skipped, 'the caller is told rows were dropped rather than being left to assume completeness')
  t.is(res.version, 9999, 'the watermark still advances to the head — a gap beats replaying stale ops as new')
})

test('a non-integer watermark is treated as no watermark', async (t) => {
  const bee = { version: 5, createHistoryStream: () => [][Symbol.iterator]() }
  t.alike(await readChangesSince(bee, null), { version: 5, nodes: [], skipped: false })
})
