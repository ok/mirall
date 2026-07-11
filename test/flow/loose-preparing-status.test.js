import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// B3 — while the owner indexes a loose file (contentHash still null), the peer's files:list
// row transitions through a pre-availability state and then settles to 'remote' once the hash
// lands, and downloads cleanly. Existing tests `until(status==='remote')` and skip the
// intermediate; this characterizes the pre-remote status the peer actually observes. FE s86.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

test('peer observes a loose file settle from indexing to remote while the owner hashes',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aSrc = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    // Big so the owner's hashing window is observable to the peer.
    const bytes = patternedBytes(64 * 1024 * 1024, 15)
    fs.writeFileSync(path.join(aSrc, 'reel.bin'), bytes)
    A.request('files:add', { spaceId, filePath: path.join(aSrc, 'reel.bin'), fileName: 'reel.bin', fileSize: bytes.length }).catch(() => {})

    // Poll the peer's row across the owner's indexing → settle, recording the pre-remote statuses.
    const preRemote = new Set()
    let becameRemote = false
    const deadline = Date.now() + scaled(90000)
    while (Date.now() < deadline) {
      const list = await B.request('files:list', { spaceId }).catch(() => null)
      const row = Array.isArray(list) ? list.find((e) => e.path === '/reel.bin') : null
      if (row) {
        if (row.status === 'remote') { becameRemote = true; break }
        preRemote.add(row.status)
      }
      await sleep(200)
    }
    t.ok(becameRemote, 'the loose file settles to remote for the peer once the owner finishes indexing')
    t.comment(`pre-remote statuses the peer observed during owner indexing: ${[...preRemote].join(', ') || '(none — appeared directly as remote)'}`)
    t.absent(preRemote.has('error'), 'the peer never observes a Failed/error state during owner indexing')

    // And it downloads cleanly once remote.
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/reel.bin', 120000)
    await B.request('files:download', { spaceId, path: '/reel.bin', inPlace: true, ownerKey: aKey })
    const completion = await done
    t.ok(fs.readFileSync(completion.localPath).equals(bytes), 'downloads byte-exact after settling to remote')
    A.kill()
  })
