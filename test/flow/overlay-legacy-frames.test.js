import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { rawContentPeer } from '../helpers/raw-content-peer.js'
import { mkTmpDir, patternedBytes, dirSize, mkStoreDir } from '../helpers/fixtures.js'
import { waitFor } from '../helpers/poll.js'
import { scaled } from '../helpers/timing.js'
import { decodeInvite } from '../../src/shared/contract/invite-envelope.js'

// A socket on a space's content topic reaches the overlay channel before its identity is known. The
// legacy path-sync frames it can send must be no-ops: no sync feed is announced to it, a flood of
// transfer-complete frames behind a large feed key writes nothing to the owner's store, and a member's
// download from the owner is unaffected.
const KEY_BYTES = 256 * 1024 // random, so neither hex nor store compression hides the rows
const FRAMES = 64
const flush = (ms = scaled(1500)) => new Promise((r) => setTimeout(r, ms))

test('REGRESSION (MIR-53: legacy sync frames from a raw content-topic peer neither grow the owner\'s store nor stop a download)',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = mkStoreDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t) })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).personKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const bytes = patternedBytes(256 * 1024, 13)
    fs.writeFileSync(path.join(folder, 'big.bin'), bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (e) => e.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => f?.entries?.some((e) => e.relPath === 'big.bin' && e.status === 'remote'), { ms: 60000 })

    const topicHex = decodeInvite(await A.request('space:invite', { spaceId })).topic
    const raw = await rawContentPeer(t, { bootstrap, topicHex })
    await waitFor(() => raw.connections() >= 2, 30000, { label: 'raw peer on both content sockets' })
    await flush()
    t.is(raw.seen.syncState.length, 0, 'neither worker announced its sync feed')

    await flush()
    const before = dirSize(aStore)
    raw.send('syncState', { feedKey: randomBytes(KEY_BYTES), localSeq: 0, remoteSeq: 0 })
    for (let i = 0; i < FRAMES; i++) raw.send('transferComplete', { path: '/junk/' + i, contentHash: 'cd'.repeat(32) })

    const done = B.waitFor('event:transfer-complete', (e) => e.path === '/Vault/big.bin', 60000)
    await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'big.bin' })
    const completed = await done
    t.ok(fs.readFileSync(completed.localPath).equals(bytes), "B downloaded the owner's bytes during the flood")

    await flush()
    const grew = dirSize(aStore) - before
    t.ok(grew < (FRAMES * 2 * KEY_BYTES) / 4, `owner store grew ${grew}B under ${FRAMES} legacy frames`)
  })
