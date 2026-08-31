import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const FLAGS = { overlayEnabled: true, sharePrepareProgressEnabled: true }

// Pausing an owner's index has a member-visible effect no single-peer test can see: emptying the
// queue pokes progress, which goes out over the handshake channel as a zero frame. Without it the
// member's "Alice is adding N files" notice describes work that stopped minutes ago, and nothing
// ever corrects it — the frames are ephemeral and never replayed.
test('a member is told when the owner pauses, so its scan notice cannot stick',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })

    // Armed before the mount: the frame is not replayed, so a late listener sees nothing.
    const gotQueue = B.waitFor('event:share-index-progress',
      (m) => m.spaceId === spaceId && m.shareId === share.id && m.adding > 1, 60000)

    const folder = mkTmpDir(t)
    // Six, so the queue is unambiguously deeper than the lane can hash at once — otherwise the scan
    // drains before the pause lands and there is nothing to interrupt.
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(folder, `vol-0${i}.bin`), patternedBytes(4 * 1024 * 1024, 7 + i))
    }
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    const ev = await gotQueue
    t.ok(ev.adding > 1, 'precondition: the member is watching a scan with work still queued')

    const gotDrain = B.waitFor('event:share-index-progress',
      (m) => m.spaceId === spaceId && m.shareId === share.id && m.adding === 0, 60000)
    const paused = await A.request('owned-folder:pause-index', { spaceId, shareId: share.id })
    t.ok(paused.paused, 'the owner records the pause')
    await gotDrain
    t.pass('and announces the emptied queue, so the member is not left on a stale count')

    // A pause is not an unshare: whatever had already replicated stays listable for the member.
    const listing = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
    t.ok(Array.isArray(listing?.entries), 'the member can still list the folder while it is paused')

    // Resuming finishes the job — the durable pause is the only thing that was holding it.
    const resumedQueue = B.waitFor('event:share-index-progress',
      (m) => m.spaceId === spaceId && m.shareId === share.id && m.adding > 0, 60000)
    await A.request('owned-folder:resume-index', { spaceId, shareId: share.id })
    await resumedQueue
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.length === 6,
      { ms: 90000 })
    t.pass('the whole folder reaches the member after the resume')
  })
