// Ported from hyper-overlay upstream test/overlay-v2-restart-durability.test.js
// (6cac8ee). Body verbatim; only import paths retargeted to the vendored subset.
// Exercises a cold publisher serving by content hash with NO serveAuthorizer
// wired — proving the §4.1 gate is a no-op when absent (backward-compatible).
import test from 'brittle'
import Protomux from 'protomux'
import crypto from 'hypercore-crypto'
import { Duplex } from 'streamx'
import { tmpStore, tmpDir, fs, path } from './overlay-vendor-helpers.js'
import { HyperOverlayV2 } from '../../src/shared/transfer/backends/overlay/vendor/overlay-v2.js'

// Phase 2: a forge serves hyper-tps' large files (NOT stored in git) by content
// hash over hyper-overlay — the deliberate "no hyperblobs" design. The canonical
// bytes live at <spool>/<oid> (content-addressed; pear-git-v3 router.js spools an
// upload to spool/<oid>, where oid IS the blake2b content hash). After a daemon
// restart the in-memory _contentHashPaths map is empty and FileIndex persists no
// disk path, so the publisher must resolve a content request straight from the
// content-addressed spool. This reproduces a COLD publisher (bytes in the spool,
// empty maps, never registerFile'd) and asserts it still serves — exactly the
// post-restart condition that currently breaks cross-machine LFS serving.

function makeDuplex () {
  let aWrite, bWrite
  const a = new Duplex({ write (d, cb) { bWrite(d); cb() }, read () {} })
  const b = new Duplex({ write (d, cb) { aWrite(d); cb() }, read () {} })
  aWrite = (d) => a.push(d)
  bWrite = (d) => b.push(d)
  return [a, b]
}

const settle = (ms = 400) => new Promise(r => setTimeout(r, ms))

test('RESTART DURABILITY: a cold publisher serves by content hash from the content-addressed spool', async (t) => {
  const spool = tmpDir('ov2-rd-spool')
  const content = crypto.randomBytes(300 * 1024)
  const oid = crypto.data(content).toString('hex')
  fs.writeFileSync(path.join(spool, oid), content) // canonical bytes at <spool>/<oid>

  // Cold publisher: fresh store, EMPTY in-memory maps, NEVER registerFile'd —
  // exactly the post-restart state (the spool persists on disk; the maps do not).
  const pub = new HyperOverlayV2(tmpStore('ov2-rd-pub'), { namespace: 'overlay-v2', syncBaseDirs: [spool], destDir: tmpDir('ov2-rd-pub-dest') })
  const con = new HyperOverlayV2(tmpStore('ov2-rd-con'), { namespace: 'overlay-v2', destDir: tmpDir('ov2-rd-con-dest') })
  await pub.ready(); await con.ready()
  t.teardown(async () => { try { await pub.close() } catch {}; try { await con.close() } catch {} })

  const [sa, sb] = makeDuplex()
  pub.attachProtocol(Protomux.from(sa))
  con.attachProtocol(Protomux.from(sb))
  await settle()
  t.is(con.peerCount, 1, 'consumer paired with the cold publisher')

  const got = await con.fetchFile(oid, { timeout: 6000 })
  t.ok(got, 'consumer fetched from the cold publisher (served via content-addressed spool)')
  if (got) t.is(Buffer.compare(fs.readFileSync(got.destPath), content), 0, 'bytes match')
})
