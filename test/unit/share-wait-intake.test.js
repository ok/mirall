import test from 'brittle'
import { createShareWaitIntake, SHARE_WAIT_VERDICT as V } from '../../src/shared/network/share-wait-intake.js'
import { ARG_MAX } from '../../src/shared/contract/limits.js'

const MEMBER = 'm'.repeat(64)
const STRANGER = 's'.repeat(64)
const SOCKET = {}

function rig({ entries = {}, cap = Infinity, busy = false, enabled = true } = {}) {
  const marked = []
  const cleared = []
  let release = null
  const intake = createShareWaitIntake({
    enabled: () => enabled,
    authorizedOn: (socket, key) => socket === SOCKET && key === MEMBER,
    inSpace: (key, spaceId) => key === MEMBER && spaceId === 'space1',
    ownEntry: async (spaceId, shareId, relPath) => {
      if (release) await release
      return entries[shareId + ':' + relPath] ?? null
    },
    markWaiting: (ref) => {
      if (busy) return 'busy'
      if (marked.length >= cap) return 'capped'
      marked.push(ref)
      return 'marked'
    },
    clearWaiting: (ref) => cleared.push(ref),
  })
  const hold = () => { let open; release = new Promise((resolve) => { open = resolve }); return () => { release = null; open() } }
  return { intake, marked, cleared, hold }
}

const frame = (o = {}) => ({ type: 'share-wait', profileKey: MEMBER, spaceId: 'space1', shareId: 'share1', relPath: 'big.bin', ...o })
const unhashed = { 'share1:big.bin': { relPath: 'big.bin', contentHash: null } }

test('a member waiting on one of our unhashed files is marked', async (t) => {
  const { intake, marked } = rig({ entries: unhashed })
  t.is(await intake.handle(SOCKET, frame()), V.MARKED)
  t.alike(marked, [{ spaceId: 'space1', shareId: 'share1', relPath: 'big.bin', from: MEMBER }])
})

test('a sender not authenticated on this socket is dropped', async (t) => {
  const { intake, marked } = rig({ entries: unhashed })
  t.is(await intake.handle(SOCKET, frame({ profileKey: STRANGER })), V.UNAUTHORIZED)
  t.is(await intake.handle({}, frame()), V.UNAUTHORIZED, 'the right key on another socket is not enough')
  t.is(await intake.handle(SOCKET, frame({ profileKey: 42 })), V.UNAUTHORIZED)
  t.is(marked.length, 0)
})

test('a member naming a space it is not in with us is dropped', async (t) => {
  const { intake, marked } = rig({ entries: unhashed })
  t.is(await intake.handle(SOCKET, frame({ spaceId: 'space2' })), V.NOT_IN_SPACE)
  t.is(await intake.handle(SOCKET, frame({ spaceId: null })), V.NOT_IN_SPACE)
  t.is(marked.length, 0)
})

test('missing, empty or oversized strings are dropped before any read', async (t) => {
  const { intake, marked } = rig({ entries: unhashed })
  t.is(await intake.handle(SOCKET, frame({ shareId: 'x'.repeat(ARG_MAX.key + 1) })), V.MALFORMED)
  t.is(await intake.handle(SOCKET, frame({ relPath: 'x'.repeat(ARG_MAX.path + 1) })), V.MALFORMED)
  t.is(await intake.handle(SOCKET, frame({ relPath: '' })), V.MALFORMED)
  t.is(await intake.handle(SOCKET, frame({ shareId: { toString: () => 'share1' } })), V.MALFORMED)
  t.is(marked.length, 0)
})

test('a file that is not in our own catalog is dropped', async (t) => {
  const { intake, marked } = rig({ entries: unhashed })
  t.is(await intake.handle(SOCKET, frame({ shareId: 'someone-elses-share' })), V.NOT_OURS)
  t.is(await intake.handle(SOCKET, frame({ relPath: 'nothing-here.bin' })), V.NOT_OURS)
  t.is(marked.length, 0)
})

test('a file we have already hashed is dropped', async (t) => {
  const { intake, marked } = rig({ entries: { 'share1:big.bin': { relPath: 'big.bin', contentHash: 'h'.repeat(64) } } })
  t.is(await intake.handle(SOCKET, frame()), V.HASHED)
  t.is(marked.length, 0)
})

test('a catalog read that throws is dropped, not marked', async (t) => {
  const intake = createShareWaitIntake({
    authorizedOn: () => true,
    inSpace: () => true,
    ownEntry: async () => { throw new Error('legacy space') },
    markWaiting: () => { t.fail('never marked'); return 'capped' },
    clearWaiting: () => {},
  })
  t.is(await intake.handle(SOCKET, frame()), V.NOT_OURS)
})

test('a peer at its cap is reported as capped', async (t) => {
  const { intake } = rig({ entries: unhashed, cap: 0 })
  t.is(await intake.handle(SOCKET, frame()), V.CAPPED)
})

test('cancel clears without a catalog read, and wins over a wait still reading', async (t) => {
  const { intake, marked, cleared, hold } = rig({ entries: unhashed })
  const open = hold()
  const pending = intake.handle(SOCKET, frame())
  t.is(await intake.handle(SOCKET, frame({ cancel: true })), V.CLEARED)
  t.alike(cleared, [{ spaceId: 'space1', shareId: 'share1', relPath: 'big.bin', from: MEMBER }])
  open()
  t.is(await pending, V.SUPERSEDED, 'the earlier wait does not resurrect the row')
  t.is(marked.length, 0)
})

test('with our own prepare-progress switch off, every notice is dropped', async (t) => {
  const { intake, marked, cleared } = rig({ entries: unhashed, enabled: false })
  t.is(await intake.handle(SOCKET, frame()), V.DISABLED)
  t.is(await intake.handle(SOCKET, frame({ cancel: true })), V.DISABLED)
  t.is(marked.length + cleared.length, 0)
})

test('a row that is a live serve of another share under the same path is reported busy', async (t) => {
  const { intake } = rig({ entries: unhashed, busy: true })
  t.is(await intake.handle(SOCKET, frame()), V.BUSY)
})
