import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { LINKS } from '../helpers/impair.js'

const FLAGS = (netImpair) => ({ overlayEnabled: true, separateContentPlane: true, ...(netImpair ? { netImpair } : {}) })

// Bulk content rides its own transport, so control-plane replication (a peer's newly shared
// folder) is not blocked behind an in-flight download. Both peers run an impaired link so the
// 48 MB download stays in flight for the whole assertion window (t.absent(completed) proves the
// download had NOT finished when the share surfaced). This is a behavior gate, not a red-first
// repro: the original "invisible until pause" starvation only bites on a bandwidth-constrained
// real link the hermetic testnet can't reproduce, and the existing sender-drain / receiver-yield
// dampeners keep control-plane latency low here (measured ~1.3s with or without the split). See
// the plan for the real-link verification.
test('a newly shared folder surfaces on a peer while a download is in flight over the content plane',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS(LINKS.transcontinental) })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS(LINKS.transcontinental) })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const src = path.join(mkTmpDir(t), 'big.bin')
    const bytes = patternedBytes(48 * 1024 * 1024, 41)
    fs.writeFileSync(src, bytes)
    await A.request('files:add', { spaceId, filePath: src, fileName: 'big.bin', fileSize: bytes.length })
    await B.until('files:list', { spaceId }, (f) => Array.isArray(f) && f.some((e) => e.path === '/big.bin' && e.status === 'remote'), { ms: 120000 })

    let completed = false
    B.on('event:transfer-complete', (m) => { if (m.path === '/big.bin') completed = true })
    const flowing = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('download never started flowing')), scaled(90000))
      B.on('event:decoration', (m) => { if (m.channel === 'transfer' && m.key === '/big.bin' && m.bytes > 0 && !m.done) { clearTimeout(to); resolve() } })
    })
    await B.request('files:download', { spaceId, path: '/big.bin', inPlace: true, ownerKey: aKey })
    await flowing

    const fresh = await A.request('share:create', { spaceId, name: 'Fresh', contentMode: 'overlay' })
    await B.until('share:list', { spaceId }, (shares) => Array.isArray(shares) && shares.some((s) => s.id === fresh.id), { ms: 20000 })
    t.absent(completed, 'the download was still in flight when the new folder surfaced')
    t.pass('new folder surfaced on the downloading peer without pausing the transfer')

    A.kill()
  })

test('a download completes byte-exact over the content plane', { timeout: scaled(120000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: FLAGS() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS() })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const src = path.join(mkTmpDir(t), 'file.bin')
  const bytes = patternedBytes(4 * 1024 * 1024, 23)
  fs.writeFileSync(src, bytes)
  await A.request('files:add', { spaceId, filePath: src, fileName: 'file.bin', fileSize: bytes.length })
  await B.until('files:list', { spaceId }, (f) => Array.isArray(f) && f.some((e) => e.path === '/file.bin' && e.status === 'remote'), { ms: 60000 })

  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/file.bin', 90000)
  await B.request('files:download', { spaceId, path: '/file.bin', inPlace: true, ownerKey: aKey })
  const completion = await done
  t.ok(fs.readFileSync(completion.localPath).equals(bytes), 'downloaded bytes match source over the content plane')
  t.ok(!completion.localPath.endsWith('.mirall.part'), 'finalised, not a partial')

  A.kill()
})
