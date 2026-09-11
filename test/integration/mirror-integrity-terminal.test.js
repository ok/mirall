import test from 'brittle'
import { setupSelfMirror } from '../helpers/owned.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { runMaterializeTick, unmountForeignFolder } from '../../src/shared/folders/foreign-folders.js'
import { isTerminalFault } from '../../src/shared/transfer/backends/overlay/fetch-policy.js'
import { CODES } from '../../src/shared/contract/errors.js'

// REGRESSION (FIX-MIRROR-CHECKSUM): a holder serving bytes that fail their advertised hash was
// re-downloaded by the mirror on every 30s tick and every catalog append, forever. integrity-seen
// caps the AUDIT rows, so past the cap the loop was silent too: unbounded bandwidth, no user-visible
// error, no terminal state. The engine has treated the same fault as terminal since v1.7 —
// architecture §4.5, "re-fetching from the same holder would fail identically".

function badHolder(t, { code = 'EHASHMISMATCH' } = {}) {
  const overlay = getOverlay()
  const inner = overlay.fetchFile
  const seen = []
  overlay.fetchFile = async (hash, opts) => {
    seen.push(opts?.destPath ?? hash)
    const e = new Error('served bytes do not match'); e.code = code; throw e
  }
  t.teardown(() => { overlay.fetchFile = inner })
  return seen
}

test('the shared rule calls a checksum failure terminal', (t) => {
  t.ok(isTerminalFault(CODES.TRANSFER_CHECKSUM))
})

test('REGRESSION (FIX-MIRROR-CHECKSUM): a bad holder is not re-fetched every tick', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x', 'b.txt': 'y' } })
  const seen = badHolder(t)

  // The budget is 3, so the retries are bounded, not zero: the overlay is multi-source and a
  // second holder deserves its turn before the mirror gives up on the content.
  for (let i = 0; i < 8; i++) await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(seen.length, 6, 'two files x a 3-attempt budget, then it stops asking')

  const before = seen.length
  for (let i = 0; i < 5; i++) await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(seen.length, before, 'five further ticks re-fetched nothing')
})

// The reason it is a budget. A permanent block on the first bad byte would condemn content that a
// healthy holder can serve, with no way back short of a remount.
test('a healthy holder still gets its turn after a bad one', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x' } })
  const overlay = getOverlay()
  const real = overlay.fetchFile
  let calls = 0
  overlay.fetchFile = async (hash, opts) => {
    calls++
    if (calls === 1) { const e = new Error('bad bytes'); e.code = 'EHASHMISMATCH'; throw e }
    return await real(hash, opts)
  }
  t.teardown(() => { overlay.fetchFile = real })

  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(calls, 2, 'the second attempt was allowed')
  const { existsSync } = await import('bare-fs')
  t.ok(existsSync(ctx.mirrorPath + '/a.txt'), 'and the good copy landed')
})

// The block is per file, not per pass: 'no-peers' ends a walk because nobody is out there, and a
// corrupt file must not be given that meaning or one bad byte-range stops the whole folder.
test('a checksum failure does not stop the pass', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' } })
  const seen = badHolder(t)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(seen.length, 3, 'every file in the folder was still attempted')
})

// A non-terminal fault must keep its retry. Only the codes the shared rule names as terminal block.
test('a stalled holder is still retried on the next tick', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x' } })
  const seen = badHolder(t, { code: 'ETIMEDOUT' })
  for (let i = 0; i < 6; i++) await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(seen.length, 6, 'a non-terminal fault is re-attempted without limit')
})

// The forgiveness boundary. A re-mount is the user re-pointing the folder, which deserves a fresh
// attempt — and it is what makes an in-memory block acceptable in place of a durable row.
test('a remount clears the block', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x' } })
  const seen = badHolder(t)
  for (let i = 0; i < 4; i++) await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(seen.length, 3, 'the budget is spent')

  await unmountForeignFolder(ctx.spaceId, ctx.share.id)
  const { createForeignMount } = await import('../../src/shared/folders/mount-store.js')
  await createForeignMount({ ...ctx.mount, syncedPaths: [] })
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(seen.length, 4, 'the re-made mount attempted the file again')
})
