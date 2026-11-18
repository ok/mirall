import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { registerTransfers } from '../../src/worker/ipc/transfers.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { recordPending } from '../../src/shared/transfer/pending-transfers.js'
import { createForeignMount } from '../../src/shared/folders/mount-store.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'

const OWNER = 'o'.repeat(64)
const HASH = 'h'.repeat(64)
const noLog = { warn() {}, debug() {}, info() {}, error() {} }

const looseRow = (relPath, over = {}) => ({ inPlace: true, shareId: LOOSE_SHARE_ID, relPath, ownerKey: OWNER, total: 1000, contentHash: HASH, bytesTransferred: 400, ...over })
const folderRow = (shareId, relPath, over = {}) => ({ inPlace: false, overlayShare: true, shareId, relPath, ownerKey: OWNER, total: 2000, contentHash: HASH, bytesTransferred: 100, ...over })

async function setup(t) {
  const peer = await freshPeer(t)
  registerTransfers(peer.fake.ipc, { log: noLog })
  return peer
}

test('transfers:list is empty while nothing is pending or served', async (t) => {
  const p = await setup(t)
  t.alike(await p.fake.call('transfers:list', {}), [])
})

test('transfers:list gathers the downloads of every space into one list', async (t) => {
  const p = await setup(t)
  const a = await createSpace('Dailies')
  const b = await createSpace('Rebrand')
  await recordPending(a.spaceId, '/reel.mov', looseRow('reel.mov'))
  await recordPending(b.spaceId, '/Key visuals/hero.psd', folderRow('share-1', 'hero.psd'))
  const groups = await p.fake.call('transfers:list', {})
  t.alike(groups.map((g) => g.spaceId).sort(), [a.spaceId, b.spaceId].sort())
  const inA = groups.find((g) => g.spaceId === a.spaceId).downloads
  const inB = groups.find((g) => g.spaceId === b.spaceId).downloads
  t.is(inA.length, 1)
  t.is(inA[0].kind, 'loose')
  t.is(inA[0].file.path, '/reel.mov')
  t.is(inA[0].file.status, 'paused-offline', 'no slot and the owner is not connected')
  t.is(inB[0].kind, 'share')
  t.is(inB[0].folder, 'Key visuals')
  t.is(inB[0].file.relPath, 'hero.psd')
})

// A mirrored folder keeps itself in sync: its files are not transfers the user asked for, even when
// one was asked for before the folder was mirrored.
test('a download in a folder this device mirrors is not listed', async (t) => {
  const p = await setup(t)
  const a = await createSpace('Dailies')
  await recordPending(a.spaceId, '/Grade/lut.cube', folderRow('share-m', 'lut.cube'))
  await createForeignMount({ spaceId: a.spaceId, shareId: 'share-m', ownerKey: OWNER, mountPath: '/tmp/never-read', enabled: true })
  t.alike(await p.fake.call('transfers:list', {}), [])
})

test('a pending row the download engine did not write is not listed', async (t) => {
  const p = await setup(t)
  const a = await createSpace('Dailies')
  await recordPending(a.spaceId, '/other.bin', { shareId: 'x', relPath: 'other.bin', ownerKey: OWNER, total: 10, bytesTransferred: 1 })
  t.alike(await p.fake.call('transfers:list', {}), [])
})

test('a download of a space that is gone is not listed', async (t) => {
  const p = await setup(t)
  await recordPending('f'.repeat(64), '/reel.mov', looseRow('reel.mov'))
  t.alike(await p.fake.call('transfers:list', {}), [])
})

test('transfers:pause-all reaches what would move by itself, and leaves a failed row alone', async (t) => {
  const p = await setup(t)
  const a = await createSpace('Dailies')
  await recordPending(a.spaceId, '/waiting-on-owner.mov', looseRow('waiting-on-owner.mov'))
  await recordPending(a.spaceId, '/failed.mov', looseRow('failed.mov', { errorCode: 'TRANSFER_STALLED' }))
  t.alike(await p.fake.call('transfers:pause-all', {}), { count: 1 })
})

test('transfers:resume-all resumes nothing while no download is paused by an interruption', async (t) => {
  const p = await setup(t)
  const a = await createSpace('Dailies')
  await recordPending(a.spaceId, '/waiting-on-owner.mov', looseRow('waiting-on-owner.mov'))
  t.alike(await p.fake.call('transfers:resume-all', {}), { count: 0 })
})
