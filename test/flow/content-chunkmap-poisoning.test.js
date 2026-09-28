import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { rawContentPeer } from '../helpers/raw-content-peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { waitFor } from '../helpers/poll.js'
import { scaled } from '../helpers/timing.js'
import { decodeInvite } from '../../src/shared/contract/invite-envelope.js'

// Any socket on a space's content topic reaches the overlay channel before its identity is known.
// Such a peer must never learn which hashes a member fetches, and a chunk map it pushes, asked or
// not, must never become the download's geometry: the member downloads the owner's bytes.
test('REGRESSION (MIR-46: a raw content-topic peer cannot poison a member download; MIR-67: it never sees the request)',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t) })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t) })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).personKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const bytes = patternedBytes(256 * 1024, 11)
    fs.writeFileSync(path.join(folder, 'big.bin'), bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (e) => e.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone
    const listed = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => f?.entries?.some((e) => e.relPath === 'big.bin' && e.status === 'remote'), { ms: 60000 })
    const entry = listed.entries.find((e) => e.relPath === 'big.bin')

    const forged = { path: 'content:' + entry.hash, tier: 0, chunks: [{ hash: 'e'.repeat(64), length: entry.size * 4 }], more: 0 }
    const topicHex = decodeInvite(await A.request('space:invite', { spaceId })).topic
    const raw = await rawContentPeer(t, { bootstrap, topicHex, answer: () => forged })
    await waitFor(() => raw.connections() >= 2, 30000, { label: 'raw peer on both content sockets' })
    const spam = setInterval(() => raw.push(forged), 25)
    t.teardown(() => clearInterval(spam))

    const done = B.waitFor('event:transfer-complete', (e) => e.path === '/Vault/big.bin', 60000)
    await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'big.bin' })
    const completed = await done
    t.ok(fs.readFileSync(completed.localPath).equals(bytes), "B holds the owner's bytes")
    t.is(raw.seen.contentRequest.length, 0, 'the raw peer never received the content request')
    t.is(raw.seen.transferControl.length + raw.seen.transferProgress.length, 0, 'nor any transfer frame about it')
  })
