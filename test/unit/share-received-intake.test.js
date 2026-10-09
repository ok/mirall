import test from 'brittle'
import { createShareReceivedIntake, SHARE_RECEIVED_VERDICT as V } from '../../src/shared/network/share-received-intake.js'
import { ARG_MAX } from '../../src/shared/contract/limits.js'

const MEMBER = 'm'.repeat(64)
const STRANGER = 's'.repeat(64)
const HASH = 'h'.repeat(64)
const SOCKET = {}

function rig(entries = { 'share1:report.pdf': { relPath: 'report.pdf', size: 2048, contentHash: HASH } }) {
  const noted = []
  const intake = createShareReceivedIntake({
    authorizedOn: (socket, key) => socket === SOCKET && key === MEMBER,
    inSpace: (key, spaceId) => key === MEMBER && spaceId === 'space1',
    ownEntry: async (spaceId, shareId, relPath) => entries[shareId + ':' + relPath] ?? null,
    noteRecipient: async (note) => { noted.push(note) },
  })
  return { intake, noted }
}

const frame = (o = {}) => ({ type: 'share-received', profileKey: MEMBER, spaceId: 'space1', shareId: 'share1', relPath: 'report.pdf', contentHash: HASH, ...o })

test('a member confirming the current version of one of our files is noted', async (t) => {
  const { intake, noted } = rig()
  t.is(await intake.handle(SOCKET, frame()), V.RECORDED)
  t.alike(noted, [{ spaceId: 'space1', shareId: 'share1', relPath: 'report.pdf', contentHash: HASH, personKey: MEMBER, size: 2048 }])
})

test('a notice claiming someone else, or a space the sender is not in, notes nobody', async (t) => {
  const { intake, noted } = rig()
  t.is(await intake.handle(SOCKET, frame({ profileKey: STRANGER })), V.UNAUTHORIZED)
  t.is(await intake.handle({}, frame()), V.UNAUTHORIZED, 'the key must be the one authenticated on this socket')
  t.is(await intake.handle(SOCKET, frame({ spaceId: 'space2' })), V.NOT_IN_SPACE)
  t.is(noted.length, 0)
})

test('a file we do not share, or a version we no longer advertise, notes nobody', async (t) => {
  const { intake, noted } = rig()
  t.is(await intake.handle(SOCKET, frame({ relPath: 'other.pdf' })), V.NOT_OURS)
  t.is(await intake.handle(SOCKET, frame({ contentHash: 'o'.repeat(64) })), V.STALE)
  t.is(noted.length, 0)
})

test('unbounded or missing strings are refused before the catalog is read', async (t) => {
  let reads = 0
  const intake = createShareReceivedIntake({
    authorizedOn: () => true,
    inSpace: () => true,
    ownEntry: async () => { reads++; return null },
    noteRecipient: async () => {},
  })
  t.is(await intake.handle(SOCKET, frame({ relPath: 'x'.repeat(ARG_MAX.path + 1) })), V.MALFORMED)
  t.is(await intake.handle(SOCKET, frame({ contentHash: undefined })), V.MALFORMED)
  t.is(await intake.handle(SOCKET, frame({ shareId: '' })), V.MALFORMED)
  t.is(reads, 0)
})
