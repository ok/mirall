import test from 'brittle'
import { downloadRowFor, groupTransfers } from '../../src/shared/transfer/transfer-overview.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'

const OWNER = 'o'.repeat(64)
const HASH = 'h'.repeat(64)
const loose = (over = {}) => ({ filePath: '/reel.mov', relPath: 'reel.mov', shareId: LOOSE_SHARE_ID, ownerKey: OWNER, total: 1000, contentHash: HASH, bytesTransferred: 400, ...over })
const folder = (over = {}) => ({ filePath: '/Dailies/day 04/reel.mov', relPath: 'day 04/reel.mov', shareId: 'share-1', ownerKey: OWNER, total: 1000, contentHash: HASH, bytesTransferred: 0, ...over })
const facts = (over = {}) => ({ phase: null, ownerOnline: true, ownerName: 'Maya', ...over })

test('a loose download is the row its space lists, keyed by its drive path', (t) => {
  const d = downloadRowFor('s1', loose(), facts({ phase: 'active' }))
  t.is(d.kind, 'loose')
  t.is(d.folder, null)
  t.is(d.file.path, '/reel.mov')
  t.is(d.file.status, 'downloading')
  t.is(d.file.size, 1000)
  t.is(d.file.pendingBytes, 400)
  t.is(d.file.transferId, 's1|' + LOOSE_SHARE_ID + '|reel.mov')
  t.alike(d.file.owner, { displayName: 'Maya', publicKey: OWNER })
})

test('a folder download names its folder and keeps the path inside it', (t) => {
  const d = downloadRowFor('s1', folder(), facts({ phase: 'waiting' }))
  t.is(d.kind, 'share')
  t.is(d.folder, 'Dailies')
  t.is(d.file.relPath, 'day 04/reel.mov')
  t.is(d.file.status, 'waiting')
  t.is(d.file.transferId, 's1|share-1|day 04/reel.mov')
})

test('a row with no slot reads paused, by whether its owner is reachable', (t) => {
  t.is(downloadRowFor('s1', loose(), facts()).file.status, 'paused-interrupted')
  t.is(downloadRowFor('s1', loose(), facts({ ownerOnline: false })).file.status, 'paused-offline')
})

test('a failed row carries its error code', (t) => {
  const d = downloadRowFor('s1', loose({ errorCode: 'TRANSFER_STALLED' }), facts())
  t.is(d.file.status, 'error')
  t.is(d.file.errorCode, 'TRANSFER_STALLED')
})

// A click the owner has not hashed yet is a wait on their indexing, which the page leaves out.
test('a row still waiting for its owner to hash the file is not a transfer', (t) => {
  const intent = loose({ contentHash: undefined, total: 0, bytesTransferred: 0 })
  t.is(downloadRowFor('s1', intent, facts()), null, 'owner online: preparing')
  t.is(downloadRowFor('s1', intent, facts({ ownerOnline: false })), null, 'owner offline: not available')
})

test('transfers group by space, and a file only waited on is not being sent', (t) => {
  const a = downloadRowFor('s1', loose(), facts({ phase: 'active' }))
  const b = downloadRowFor('s2', folder(), facts({ phase: 'active' }))
  const serve = (spaceId, path, peers) => ({ spaceId, path, peers, bytes: 0, total: 0, pausedKeys: [], waitingKeys: [], shareId: LOOSE_SHARE_ID, size: 10 })
  const groups = groupTransfers({
    downloads: [{ spaceId: 's1', download: a }, { spaceId: 's2', download: b }],
    serving: [serve('s2', '/a.zip', ['p1']), serve('s3', '/b.zip', ['p1', 'p2']), serve('s1', '/hashing.zip', [])],
  })
  t.alike(groups.map((g) => g.spaceId), ['s1', 's2', 's3'])
  t.alike(groups.map((g) => g.downloads.length), [1, 1, 0])
  t.alike(groups.map((g) => g.serving.length), [0, 1, 1], 'the waited-on file is left out')
})
