import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const flags = (o = {}) => ({ sharePrepareProgressEnabled: true, identityKEK: kekHex(), ...o })

// Sparse, so it costs no disk to write, while the owner still hashes every byte of it — which is
// what holds the waiting window open long enough to observe.
function sparseFile(dir, name, bytes) {
  const p = path.join(dir, name)
  fs.closeSync(fs.openSync(p, 'w'))
  fs.truncateSync(p, bytes)
  return p
}
const GB = 1024 * 1024 * 1024

const serving = (spaceId, p) => (m) => m.channel === 'serving' && m.spaceId === spaceId && m.path === p

// The member's mirror walks the owner's half-advertised entry, and the owner's ledger names the
// member as waiting — on the summary and the detail tier, never as a downloader — BEFORE its own
// hash lands. Once it lands the mirror fetches, and the waiter becomes a downloader.
test('a mirror waiting on an unhashed file shows on the owner as waiting, then as downloading',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).personKey
    const bKey = (await B.request('profile:get')).personKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id, 60000)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone
    await B.until('share:list', { spaceId }, (list) => Array.isArray(list) && list.some((s) => s.id === share.id), { ms: 60000 })
    await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mkTmpDir(t) })
    await A.request('serving:detail-subscribe', { spaceId, path: 'big.bin' })

    const order = []
    const isHere = serving(spaceId, 'big.bin')
    const waiting = A.waitFor('event:awareness', (m) => isHere(m) && m.waitingKeys?.includes(bKey), 120000)
      .then((m) => { order.push('waiting'); return m })
    const waitingDetail = A.waitFor('event:awareness',
      (m) => m.channel === 'serving-detail' && m.spaceId === spaceId && m.path === 'big.bin' && m.peers.some((p) => p.personKey === bKey && p.waiting), 120000)
      .then((m) => { order.push('detail'); return m })
    const hashed = A.waitFor('event:decoration',
      (m) => m.channel === 'transfer' && m.key === share.id + ':big.bin' && m.done === true, 180000)
      .then(() => { order.push('hashed') })
    const downloading = A.waitFor('event:awareness', (m) => isHere(m) && m.peers.includes(bKey), 200000)

    const big = sparseFile(folder, 'big.bin', 3 * GB)
    A.request('event:owned-folder-fs-event', { shareId: share.id, action: 'add', relPath: 'big.bin', absPath: big })
      .catch((err) => t.fail('fs event failed: ' + err.message))

    const w = await waiting
    t.alike(w.peers, [], 'the waiting member is not listed as a downloader')
    t.is(w.bytes, 0, 'and adds nothing to the byte sums')
    t.is(w.total, 0)
    await waitingDetail
    t.pass('the detail tier marks the member waiting')

    await hashed
    t.alike(order, ['waiting', 'detail', 'hashed'], 'the owner listed the member as waiting before its own hash landed')

    const d = await downloading
    t.absent(d.waitingKeys.includes(bKey), 'once the serve starts the waiter is a downloader, not both')

    await B.request('foreign-folder:unmount', { spaceId, shareId: share.id })
  })

// The manual entry point: a download asked for while the owner hashes records the intent and
// announces the wait; the member's cancel takes the owner's waiting row down at once, not after
// the idle window.
test('a loose download requested mid-hash waits on the owner, and a cancel clears it at once',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).personKey
    const bKey = (await B.request('profile:get')).personKey

    const order = []
    const isHere = serving(spaceId, '/reel.bin')
    const hashed = A.waitFor('event:decoration',
      (m) => m.channel === 'transfer' && m.key === '/reel.bin' && m.done === true, 180000)
      .then(() => { order.push('hashed') })
    const waiting = A.waitFor('event:awareness', (m) => isHere(m) && m.waitingKeys?.includes(bKey), 120000)

    const src = sparseFile(mkTmpDir(t), 'reel.bin', 3 * GB)
    A.request('files:add', { spaceId, filePath: src, fileName: 'reel.bin', fileSize: 3 * GB }).catch(() => {})
    await B.until('files:list', { spaceId },
      (l) => Array.isArray(l) && l.find((e) => e.path === '/reel.bin')?.status === 'preparing',
      { ms: 60000, every: 100 })

    const res = await B.request('files:download', { spaceId, path: '/reel.bin', ownerKey: aKey })
    t.ok(res?.queued, 'the download is queued behind the owner\'s hash')
    const w = await waiting
    t.alike(w.peers, [], 'waiting, not downloading')

    const cleared = A.waitFor('event:awareness', (m) => isHere(m) && !(m.waitingKeys ?? []).includes(bKey), 30000)
    await B.request('files:cancel-download', { transferId: `${spaceId}|__loose__|reel.bin` })
    await cleared
    order.push('cleared')
    await hashed
    t.alike(order, ['cleared', 'hashed'], 'the cancel cleared the waiter while the owner was still hashing')
    t.absent((await A.request('serving:summary-list', { spaceId })).some((s) => s.waitingKeys.includes(bKey)),
      'and nothing re-announced it')
  })

// The auto-resume path: a pending row whose owner is still hashing re-announces the wait from
// the reconcile, with nothing in memory. The member's first request is made with sending off, so
// the waiter the owner shows can only have come from the relaunched member's reconnect re-drive.
test('a pending row re-driven on reconnect announces the wait, and converts when the hash lands',
  { timeout: scaled(300000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: flags() })
    const bStore = idStore(t)
    const bDownloads = mkTmpDir(t)
    const bFlags = flags({ sharePrepareProgressEnabled: false })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStore, downloads: bDownloads, flags: bFlags })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).personKey
    const bKey = (await B.request('profile:get')).personKey

    const order = []
    const isHere = serving(spaceId, '/reel.bin')
    const hashed = A.waitFor('event:decoration',
      (m) => m.channel === 'transfer' && m.key === '/reel.bin' && m.done === true, 240000)
      .then(() => { order.push('hashed') })
    const waiting = A.waitFor('event:awareness', (m) => isHere(m) && m.waitingKeys?.includes(bKey), 180000)
      .then((m) => { order.push('waiting'); return m })

    const src = sparseFile(mkTmpDir(t), 'reel.bin', 8 * GB)
    A.request('files:add', { spaceId, filePath: src, fileName: 'reel.bin', fileSize: 8 * GB }).catch(() => {})
    await B.until('files:list', { spaceId },
      (l) => Array.isArray(l) && l.find((e) => e.path === '/reel.bin')?.status === 'preparing',
      { ms: 60000, every: 100 })
    await B.request('files:download', { spaceId, path: '/reel.bin', ownerKey: aKey })
    t.absent((await A.request('serving:summary-list', { spaceId })).some((s) => s.waitingKeys.includes(bKey)),
      'precondition: with sending off, the click told the owner nothing')

    B.kill()
    const B2 = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStore, downloads: bDownloads, flags: { ...bFlags, sharePrepareProgressEnabled: true } })
    await waiting
    t.pass('the relaunched member re-announced the wait from its pending row')

    const downloading = A.waitFor('event:awareness', (m) => isHere(m) && m.peers.includes(bKey), 240000)
    await hashed
    t.alike(order, ['waiting', 'hashed'], 'and it did so while the owner was still hashing')
    const d = await downloading
    t.absent(d.waitingKeys.includes(bKey), 'the auto-resumed fetch turned the waiter into a downloader')

    await B2.request('files:cancel-download', { transferId: `${spaceId}|__loose__|reel.bin` })
  })

// A member that goes away is waiting on nothing: the owner drops its waiting row when the socket
// closes, not after the idle window, and while it is still hashing.
test('a waiting member that quits leaves the owner\'s waiting row at once',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).personKey
    const bKey = (await B.request('profile:get')).personKey

    const order = []
    const isHere = serving(spaceId, '/reel.bin')
    const hashed = A.waitFor('event:decoration',
      (m) => m.channel === 'transfer' && m.key === '/reel.bin' && m.done === true, 240000)
      .then(() => { order.push('hashed') })
    const waiting = A.waitFor('event:awareness', (m) => isHere(m) && m.waitingKeys?.includes(bKey), 120000)

    const src = sparseFile(mkTmpDir(t), 'reel.bin', 8 * GB)
    A.request('files:add', { spaceId, filePath: src, fileName: 'reel.bin', fileSize: 8 * GB }).catch(() => {})
    await B.until('files:list', { spaceId },
      (l) => Array.isArray(l) && l.find((e) => e.path === '/reel.bin')?.status === 'preparing',
      { ms: 60000, every: 100 })
    await B.request('files:download', { spaceId, path: '/reel.bin', ownerKey: aKey })
    await waiting

    const cleared = A.waitFor('event:awareness', (m) => isHere(m) && !(m.waitingKeys ?? []).includes(bKey), 20000)
    await B.request('shutdown').catch(() => {})
    await cleared
    order.push('cleared')
    await hashed
    t.alike(order, ['cleared', 'hashed'], 'the waiter went with the member, while the owner was still hashing')
  })
