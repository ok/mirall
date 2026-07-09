import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// D3 — a MANUAL pause must survive a genuine owner offline→online RECONNECT and not be
// auto-resumed by the reconnect hook (the pausedHashes gate), while a manual resume still
// completes byte-exact. The existing FIX-EDA-2 test only drives the resume hook via an owner
// catalog re-append WHILE THE OWNER STAYS ONLINE — it never kills the owner and relaunches it.
// The user reports manual-pause-across-reconnect failing on real machines; this is the faithful
// reproduction (owner subprocess killed while B is registered offline, then relaunched on the
// same storage/identity, driving B's resumeForOwner reconnect hook).
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

test('manual pause survives an owner offline→online reconnect (no auto-resume); manual resume completes',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = idStore(t)
    const aSrc = mkTmpDir(t)
    const aFlags = v2flags() // stable identityKEK so the relaunch reloads the SAME identity
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const bytes = patternedBytes(8 * 1024 * 1024, 47)
    fs.writeFileSync(path.join(aSrc, 'held.bin'), bytes)
    await A.request('files:add', { spaceId, filePath: path.join(aSrc, 'held.bin'), fileName: 'held.bin', fileSize: bytes.length })
    await B.until('files:list', { spaceId },
      (f) => Array.isArray(f) && f.some((e) => e.path === '/held.bin' && e.status === 'remote'), { ms: scaled(60000) })

    // Start, prove mid-flight, then MANUALLY pause.
    const flowing = new Promise((resolve) => {
      B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/held.bin' && m.bytes > 0) resolve() })
    })
    await B.request('files:download', { spaceId, path: '/held.bin', inPlace: true, ownerKey: aKey })
    await flowing
    const transferId = (await B.request('files:list', { spaceId })).find((e) => e.path === '/held.bin')?.transferId
    t.ok(transferId, 'transferId derived on the row')
    await B.request('files:pause-download', { transferId })
    await B.until('files:list', { spaceId },
      (list) => { const e = Array.isArray(list) ? list.find((x) => x.path === '/held.bin') : null; return !!e && e.status === 'paused-interrupted' },
      { ms: scaled(60000) })

    // Owner goes offline; B genuinely registers the outage.
    A.kill()
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: scaled(90000) })

    // Owner returns → B's resumeForOwner reconnect hook fires. A MANUAL pause must NOT be resurrected.
    let autoResumed = false
    B.on('event:transfer-complete', (m) => { if (m.path === '/held.bin') autoResumed = true })
    B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.key === '/held.bin' && m.bytes > 0) autoResumed = true })
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: aFlags })
    await B.until('members:online', { spaceId }, (o) => o.includes(aKey), { ms: scaled(90000) })
    await sleep(8000) // give the reconnect hook ample time to (wrongly) auto-resume

    const row = (await B.request('files:list', { spaceId })).find((e) => e.path === '/held.bin')
    t.ok(row && (row.status === 'paused-interrupted' || row.status === 'paused-offline'),
      `manual pause survives the owner reconnect (row status=${row?.status})`)
    t.absent(autoResumed, 'no auto-resume progress/completion after the owner reconnects')
    t.absent(fs.existsSync(path.join(B.downloads, 'held.bin')), 'the paused file did not complete on its own')

    // A manual resume still drives it to completion.
    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/held.bin', scaled(120000))
    await B.request('files:download', { spaceId, path: '/held.bin', inPlace: true, ownerKey: aKey })
    const completion = await done
    t.ok(fs.readFileSync(completion.localPath).equals(bytes), 'manual resume completes byte-exact')

    A.kill()
  })
