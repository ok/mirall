import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// B4 — the owner crashes (hard subprocess kill) WHILE indexing a loose file (contentHash
// still null), then restarts on the same store. The loose-publish restart path (GH#356): the
// entry must not be left as a permanent null-hash "publishing" zombie — on reboot it either
// re-hashes to a real share ('mine') or is cleanly absent. A stuck 'publishing' row after
// the settle window fails this test (that IS the zombie). Untested at the flow layer before now.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

test('owner crash mid-index then restart: no permanent null-hash publishing zombie',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = idStore(t)
    const aSrc = mkTmpDir(t)
    const aFlags = v2flags()
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)

    // Big enough that indexing takes a real moment (a window to crash inside).
    const bytes = patternedBytes(128 * 1024 * 1024, 3)
    fs.writeFileSync(path.join(aSrc, 'archive.bin'), bytes)

    // files:add awaits the full publish, so fire it WITHOUT awaiting and crash mid-hash.
    A.request('files:add', { spaceId, filePath: path.join(aSrc, 'archive.bin'), fileName: 'archive.bin', fileSize: bytes.length }).catch(() => {})

    // Wait until the owner advertises the still-indexing row (status 'publishing', hash null).
    let caught = false
    const deadline = Date.now() + scaled(30000)
    while (Date.now() < deadline) {
      const list = await A.request('files:list', { spaceId }).catch(() => null)
      const row = Array.isArray(list) ? list.find((e) => e.path === '/archive.bin') : null
      if (row && row.status === 'publishing') { caught = true; break }
      if (row && row.status === 'mine') break // hash finished before we could catch it
      await sleep(200)
    }
    t.comment(`caught owner mid-index (publishing): ${caught}`)

    A.kill() // hard crash mid-index

    // Relaunch on the same store; let boot rehydrate/revert settle.
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    await sleep(15000)

    let row = (await A.request('files:list', { spaceId })).find((e) => e.path === '/archive.bin')
    t.comment(`post-restart owner row: ${row ? 'status=' + row.status : 'absent'}`)
    if (row && row.status === 'publishing') {
      // A boot re-hash may still be running — give it time to resolve to 'mine' or vanish.
      // If it stays 'publishing' past this window, that is the permanent zombie → this fails.
      await A.until('files:list', { spaceId }, (list) => {
        const e = Array.isArray(list) ? list.find((x) => x.path === '/archive.bin') : null
        return !e || e.status === 'mine'
      }, { ms: scaled(90000) })
      row = (await A.request('files:list', { spaceId })).find((e) => e.path === '/archive.bin')
    }
    t.ok(!row || row.status === 'mine', 'owner entry is absent or fully shared — not a permanent publishing zombie')

    // Non-vacuous peer convergence: an absent row from never-having-replicated must NOT pass. The
    // owner deterministically resumes to 'mine' here (its source was recorded at advertise time), so
    // the peer must converge to the file being available ('remote') — not a stuck 'preparing', and
    // not a phantom that silently never arrived. (If the owner instead reverted, the peer drops it.)
    const ownerShared = !!row && row.status === 'mine'
    if (ownerShared) {
      await B.until('files:list', { spaceId }, (list) => {
        const e = Array.isArray(list) ? list.find((x) => x.path === '/archive.bin') : null
        return !!e && e.status === 'remote'
      }, { ms: scaled(60000) })
    }
    const bRow = (await B.request('files:list', { spaceId })).find((e) => e.path === '/archive.bin')
    t.comment(`post-restart peer row: ${bRow ? 'status=' + bRow.status : 'absent'}`)
    if (ownerShared) t.is(bRow?.status, 'remote', 'peer converged to the resumed share, not a stuck/absent phantom')
    else t.absent(bRow, 'peer dropped the reverted phantom')

    A.kill()
  })
