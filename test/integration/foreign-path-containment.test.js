import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import SubEncoder from 'sub-encoder'
import { setupSelfMirror } from '../helpers/owned.js'
import { getDrive } from '../../src/shared/spaces/space.js'
import { applyChange, initialMaterializeScan } from '../../src/shared/folders/foreign-folders.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { sharePrefix } from '../../src/shared/folders/path-keys.js'

// MIR-06: a malicious owner writes a RAW Hyperbee entry under Hyperdrive's
// SubEncoder('files','utf-8') keyspace (hyperdrive/index.js:16), bypassing the
// std() normalization that drive.put() applies. drive.list() serves the raw key
// verbatim, so the consuming mirror must re-validate containment independently.
// The honest API would throw "too many '..'".
const filesEnc = new SubEncoder('files', 'utf-8')

async function injectRawKey (drive, key) {
  await drive.ready()
  await drive.db.put(
    key,
    { executable: false, linkname: null, blob: null, metadata: { hash: 'deadbeef', mtime: 0 } },
    { keyEncoding: filesEnc },
  )
}

function relToSibling (mirrorPath, target) {
  return path.relative(mirrorPath, target).split(path.sep).join('/')
}

// REGRESSION (MIR-06): the strongest primitive — arbitrary file DELETION outside
// the mount. applyChange({action:'del'}) joins a peer relPath straight onto the
// mount and unlinks it with no blob read and no containment check. On the unfixed
// tree this deletes the victim; the guard must refuse it.
test('REGRESSION (MIR-06): a traversal del cannot unlink a file outside the mount', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Docs', files: { 'real.txt': 'legit' } })
  const outside = ctx.tmpDir('outside')
  const victim = path.join(outside, 'victim.txt')
  fs.writeFileSync(victim, 'precious')
  const relPath = relToSibling(ctx.mirrorPath, victim)

  await t.exception(
    applyChange(ctx.mount, { action: 'del', relPath }),
    /escapes the mount folder|outside the mount folder/,
    'applyChange(del) on a traversal relPath throws',
  )
  t.ok(fs.existsSync(victim), 'victim outside the mount survives')
  t.is(fs.readFileSync(victim, 'utf8'), 'precious', 'victim bytes intact')
})

// REGRESSION (MIR-06): a traversal put must be refused before any mkdir/read/write.
test('REGRESSION (MIR-06): a traversal put is refused', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Docs', files: { 'real.txt': 'legit' } })
  const outside = ctx.tmpDir('outside')
  const escaped = path.join(outside, 'PWNED', 'x.txt')
  const relPath = relToSibling(ctx.mirrorPath, escaped)

  await t.exception(
    applyChange(ctx.mount, { action: 'put', relPath, hash: 'deadbeef', mtime: 0, size: 0 }),
    /escapes the mount folder|outside the mount folder/,
    'applyChange(put) on a traversal relPath throws',
  )
  t.absent(fs.existsSync(path.join(outside, 'PWNED')), 'no directory created outside the mount')
})

// REGRESSION (MIR-06): the initial scan lists the raw poisoned key but must drop
// it at ingest — it is never recorded in syncedPaths, while the legitimate file
// still materializes (one bad key does not abort or DoS the mirror).
test('REGRESSION (MIR-06): the materialize scan drops a poisoned key, keeps syncing', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Docs', files: { 'real.txt': 'legit' } })
  const drive = getDrive(ctx.spaceId)
  const outside = ctx.tmpDir('outside')
  const evil = path.join(outside, 'evil.txt')
  await injectRawKey(drive, sharePrefix('Docs') + relToSibling(ctx.mirrorPath, evil))

  await initialMaterializeScan(ctx.mount)

  t.ok(fs.existsSync(path.join(ctx.mirrorPath, 'real.txt')), 'legit sibling still materialized')
  t.absent(fs.existsSync(evil), 'poisoned key never written outside the mount')
  const mount = await getForeignMount(ctx.spaceId, ctx.share.id)
  t.absent((mount.syncedPaths || []).some((p) => p.includes('..')), 'no traversal path tracked as synced')
})

test('a legitimate nested key still materializes after the guard', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Docs', files: { 'sub/deep/ok.txt': 'fine' } })
  await initialMaterializeScan(ctx.mount)
  t.ok(fs.existsSync(path.join(ctx.mirrorPath, 'sub', 'deep', 'ok.txt')), 'nested legit file materialized')
})
