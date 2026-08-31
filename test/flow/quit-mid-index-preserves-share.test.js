import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, identityKEK: kekHex() })

// B2 revert-guard: a GRACEFUL quit mid-index aborts the in-flight hash but must NOT unshare the
// file. The half-advertised null-hash entry + its owned-source link survive, so on restart boot
// rehydration re-hashes it to a real share ('mine'). A broken guard would tombstone it on quit and
// the file would vanish on restart.
test('graceful quit mid-index preserves the share: restart re-hashes to mine, not reverted',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = idStore(t)
    const aSrc = mkTmpDir(t)
    const aFlags = v2flags()
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)

    const bytes = patternedBytes(128 * 1024 * 1024, 3)
    fs.writeFileSync(path.join(aSrc, 'archive.bin'), bytes)
    A.request('files:add', { spaceId, filePath: path.join(aSrc, 'archive.bin'), fileName: 'archive.bin', fileSize: bytes.length }).catch(() => {})

    // Quit WHILE the owner is mid-index (advertised null-hash → own status 'publishing').
    await A.until('files:list', { spaceId },
      (l) => Array.isArray(l) && l.find((e) => e.path === '/archive.bin')?.status === 'publishing',
      { ms: 30000, every: 100 })
    const aPid = A.sidecar._process.pid
    await A.request('shutdown').catch(() => {})
    // Barrier: the shutdown IPC settles before the process fully exits and releases the RocksDB
    // store lock — wait for the old worker to die before reopening the same store, or the relaunch
    // races the lock.
    if (aPid) await waitForWorkerExit(aPid, scaled(8000))

    // Restart on the same store; boot rehydration must resume the null-hash entry to a real share.
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    const row = await A.until('files:list', { spaceId },
      (l) => Array.isArray(l) && l.find((e) => e.path === '/archive.bin')?.status === 'mine',
      { ms: 120000, every: 500 })
    t.is(row.find((e) => e.path === '/archive.bin').status, 'mine',
      'graceful quit mid-index left the share intact — restart re-hashed it, not reverted')

    A.kill()
  })
