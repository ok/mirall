import test from 'brittle'
import {
  createShareWaitSet, SHARE_WAIT_RESEND_MS, SHARE_WAIT_PER_OWNER, SHARE_WAIT_EXPIRE_MS, SHARE_WAIT_SOURCE as S,
} from '../../src/shared/transfer/share-wait-set.js'
import { transferIdFor, transferIdParts } from '../../src/shared/transfer/transfer-id.js'

const OWNER = 'o'.repeat(64)
const OTHER = 'q'.repeat(64)
const id = (relPath, shareId = 'share1', spaceId = 'space1') => transferIdFor(spaceId, shareId, relPath)

function rig({ connected = true } = {}) {
  let t = 1000
  const sent = []
  const state = { connected }
  const set = createShareWaitSet({
    send: (ownerKey, payload) => { if (!state.connected) return false; sent.push({ ownerKey, ...payload }); return true },
    now: () => t,
  })
  const waits = () => sent.filter((f) => !f.cancel)
  const cancels = () => sent.filter((f) => f.cancel)
  return { set, sent, waits, cancels, state, advance: (ms) => { t += ms } }
}

test('transferIdParts inverts transferIdFor, a relPath containing the separator included', (t) => {
  t.alike(transferIdParts(transferIdFor('s', 'sh', 'a|b/c.bin')), { spaceId: 's', shareId: 'sh', relPath: 'a|b/c.bin' })
  t.is(transferIdParts('no-separators'), null)
  t.is(transferIdParts(null), null)
})

test('a guard hit announces at once, then at most once per resend window', (t) => {
  const { set, sent, advance } = rig()
  t.ok(set.wait(OWNER, id('big.bin'), S.ROW))
  t.alike(sent, [{ ownerKey: OWNER, spaceId: 'space1', shareId: 'share1', relPath: 'big.bin' }])
  set.wait(OWNER, id('big.bin'), S.ROW)
  set.resend(OWNER)
  advance(SHARE_WAIT_RESEND_MS - 1)
  set.resend(OWNER)
  t.is(sent.length, 1, 'nothing more inside the window, however often it is poked')
  advance(1)
  set.resend(OWNER)
  t.is(sent.length, 2, 're-announced once the window has passed')
})

test('an unknown source is refused', (t) => {
  const { set, sent } = rig()
  t.absent(set.wait(OWNER, id('big.bin'), 'engine'))
  t.is(sent.length, 0)
})

test('an announcement that reached no channel stays due, so the owner\'s return delivers it at once', (t) => {
  const { set, sent, state } = rig({ connected: false })
  set.wait(OWNER, id('big.bin'), S.ROW)
  state.connected = true
  set.resend(OWNER)
  t.is(sent.length, 1)
})

test('REGRESSION (share-wait review: a reconnect announcement dropped before admission was throttled away)', (t) => {
  const { set, waits, advance } = rig()
  set.wait(OWNER, id('big.bin'), S.ROW)
  advance(1000)
  set.ownerReconnected(OWNER)
  set.resend(OWNER)
  t.is(waits().length, 2, 'the reconnect re-announces at once, inside the window')
  advance(500)
  set.heardFrom(OWNER, id('other.bin'))
  t.is(waits().length, 3, 'the first frame heard from the owner repeats it, still inside the window')
  advance(500)
  set.heardFrom(OWNER, id('other.bin'))
  t.is(waits().length, 3, 'and only that first one')
})

test('a mirror or click wait expires unless re-noted; a row wait never does', (t) => {
  const { set, waits, advance } = rig()
  set.wait(OWNER, id('mirror.bin'), S.MIRROR)
  set.wait(OWNER, id('click.bin'), S.CLICK)
  set.wait(OWNER, id('row.bin'), S.ROW)
  advance(SHARE_WAIT_EXPIRE_MS / 2)
  set.wait(OWNER, id('mirror.bin'), S.MIRROR)
  advance(SHARE_WAIT_EXPIRE_MS / 2 + 1)
  const before = waits().length
  set.resend(OWNER)
  t.alike(waits().slice(before).map((f) => f.relPath).sort(), ['mirror.bin', 'row.bin'], 'the unnoted click lapsed')
  advance(SHARE_WAIT_EXPIRE_MS * 10)
  const later = waits().length
  set.resend(OWNER)
  t.alike(waits().slice(later).map((f) => f.relPath), ['row.bin'], 'a long hash never drops a row-backed wait')
})

test('the owner\'s progress frame for a file keeps a mirror\'s wait on it alive', (t) => {
  const { set, waits, advance } = rig()
  set.wait(OWNER, id('big.bin'), S.MIRROR)
  for (let i = 0; i < 5; i++) { advance(SHARE_WAIT_EXPIRE_MS - 1); set.heardFrom(OWNER, id('big.bin')) }
  const before = waits().length
  advance(SHARE_WAIT_RESEND_MS)
  set.resend(OWNER)
  t.is(waits().length, before + 1, 'still waiting after several expiry windows')
  set.heardFrom(OTHER, id('big.bin'))
  advance(SHARE_WAIT_EXPIRE_MS + 1)
  set.resend(OWNER)
  t.is(waits().length, before + 1, 'another peer\'s frame does not keep it alive')
})

test('the cap is per owner, and lapsed waits free their slot', (t) => {
  const { set, advance } = rig()
  for (let i = 0; i < SHARE_WAIT_PER_OWNER; i++) t.ok(set.wait(OWNER, id('f' + i), S.CLICK))
  t.absent(set.wait(OWNER, id('one-too-many'), S.ROW), 'the next file is refused')
  t.ok(set.wait(OTHER, id('other-owner'), S.ROW), 'another owner has a cap of its own')
  advance(SHARE_WAIT_EXPIRE_MS + 1)
  t.ok(set.wait(OWNER, id('one-too-many'), S.ROW), 'stale clicks no longer starve a real wait')
})

test('hash arrival or fetch start forgets the wait without telling the owner', (t) => {
  const { set, sent } = rig()
  set.wait(OWNER, id('big.bin'), S.ROW)
  set.resolve(id('big.bin'))
  t.is(sent.length, 1, 'no cancel')
  set.wait(OWNER, id('big.bin'), S.ROW)
  t.is(sent.length, 2, 'a later guard hit is a fresh wait, announced at once')
})

test('only the file\'s own owner can say its hash is done', (t) => {
  const { set, sent, advance } = rig()
  set.wait(OWNER, id('big.bin'), S.ROW)
  set.resolve(id('big.bin'), OTHER)
  advance(SHARE_WAIT_RESEND_MS)
  set.resend(OWNER)
  t.is(sent.length, 2, 'a co-member\'s done left the wait in place')
  set.resolve(id('big.bin'), OWNER)
  advance(SHARE_WAIT_RESEND_MS)
  set.resend(OWNER)
  t.is(sent.length, 2, 'the owner\'s done resolved it')
})

test('a user stop cancels the wait on the owner, once', (t) => {
  const { set, cancels } = rig()
  set.wait(OWNER, id('big.bin'), S.ROW)
  t.ok(set.cancel(id('big.bin')))
  t.alike(cancels(), [{ ownerKey: OWNER, spaceId: 'space1', shareId: 'share1', relPath: 'big.bin', cancel: true }])
  t.absent(set.cancel(id('big.bin')), 'a second cancel has nothing to cancel')
})

test('the engine and a mirror wait on one file independently; the owner hears stop only from the last', (t) => {
  const { set, cancels, waits, advance } = rig()
  set.wait(OWNER, id('big.bin'), S.ROW)
  set.wait(OWNER, id('big.bin'), S.MIRROR)
  set.cancelShare('space1', 'share1', S.MIRROR)
  t.is(cancels().length, 0, 'a mirror stop leaves the engine waiting')
  const before = waits().length
  advance(SHARE_WAIT_RESEND_MS)
  set.resend(OWNER)
  t.is(waits().length, before + 1, 'and the engine keeps announcing')
  set.cancel(id('big.bin'))
  t.is(cancels().length, 1, 'the engine\'s stop was the last: now the owner hears it')

  set.wait(OWNER, id('two.bin'), S.CLICK)
  set.wait(OWNER, id('two.bin'), S.MIRROR)
  t.ok(set.cancel(id('two.bin')), 'an engine pause releases the engine source')
  t.is(cancels().length, 1, 'but the mirror still waits')
  set.cancelShare('space1', 'share1', S.MIRROR)
  t.is(cancels().length, 2)
  t.absent(set.cancel(id('three.bin')), 'nothing to cancel on a file never waited on')
})

test('stopping a mirror cancels only its own share', (t) => {
  const { set, cancels } = rig()
  set.wait(OWNER, id('a.bin'), S.MIRROR)
  set.wait(OWNER, id('c.bin', 'share2'), S.MIRROR)
  set.cancelShare('space1', 'share1', S.MIRROR)
  t.alike(cancels().map((f) => f.relPath), ['a.bin'])
})

test('an owner leaving the space forgets its waits silently', (t) => {
  const { set, sent, advance } = rig()
  set.wait(OWNER, id('a.bin'), S.ROW)
  set.wait(OTHER, id('b.bin'), S.ROW)
  set.forget({ spaceId: 'space1', ownerKey: OWNER })
  const before = sent.length
  advance(SHARE_WAIT_RESEND_MS)
  set.resend(OWNER)
  set.resend(OTHER)
  t.alike(sent.slice(before).map((f) => f.ownerKey), [OTHER])
  set.forget({ spaceId: 'space1' })
  advance(SHARE_WAIT_RESEND_MS)
  set.resend(OTHER)
  t.is(sent.length, before + 1, 'our own leave forgets the whole space')
  t.absent(sent.some((f) => f.cancel), 'nobody is left to tell')
})
