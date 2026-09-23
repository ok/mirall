// A download engine driven against a folder this process may not write: the folder, a holder whose
// receive path is one local write, and the channel + job the engine is judged through. Bare-only
// (bare-fs), for the integration layer.
import fs from 'bare-fs'
import path from 'bare-path'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { partialPathFor } from '../../src/shared/transfer/partial-suffix.js'

export const SPACE = 'space1'
export const OWNER = 'ownerpub'
const HASH = 'c'.repeat(64)

export function testChannel(events, job, { ownerOnline = () => true } = {}) {
  return {
    diagLabel: 'test download',
    inPlace: false,
    ownsPendingRow: (row) => row.overlayShare === true,
    pendingExtra: (j) => ({ overlayShare: true, shareId: j.shareId, relPath: j.relPath }),
    emitProgress: () => {},
    emitVerifying: () => {},
    emitError: (_job, code) => events.push(['error', code]),
    emitComplete: () => events.push(['complete']),
    emitCancelled: () => {},
    emitSuperseded: () => {},
    emitPaused: (_job, reason) => events.push(['paused', reason]),
    emitUpdated: () => {},
    emitDecorationDone: () => {},
    transferIdForRow: (spaceId, row) => spaceId + '|folder1|' + row.relPath,
    isOwnerOnline: ownerOnline,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job }),
  }
}

export function makeJob(dir) {
  return {
    spaceId: SPACE, pendingKey: '/Photos/doc.bin', path: '/Photos/doc.bin', relPath: 'doc.bin',
    shareId: 'folder1', transferId: SPACE + '|folder1|doc.bin',
    contentHash: HASH, size: 11, ownerKey: OWNER, verifyKey: 'folder1|doc.bin',
    finalPath: path.join(dir, 'doc.bin'),
  }
}

// A folder this process cannot write, or null where the mode bits do not make it so: Windows
// ignores a directory's mode and root bypasses it. The probe write is the honest test of both.
export function readOnlyDir(t, ctx, name) {
  const dir = ctx.tmpDir(name)
  fs.chmodSync(dir, 0o555)
  t.teardown(() => { try { fs.chmodSync(dir, 0o755) } catch {} })
  try {
    fs.writeFileSync(path.join(dir, '.probe'), 'x')
    return null
  } catch (err) {
    return ['EACCES', 'EPERM', 'EROFS'].includes(err.code) ? dir : null
  }
}

// The holder's receive path, reduced to its first local write: open the partial beside the final
// name, then rename it into place. On a read-only folder the open throws the real errno. `gate`
// holds the fetch open after the write until the test releases it.
export function writingHolder(seen, { gate = null } = {}) {
  getOverlay().fetchFile = async (_hash, opts) => {
    seen.push(opts.destPath)
    const part = partialPathFor(opts.destPath)
    fs.writeFileSync(part, 'hello bytes')
    if (gate) await gate()
    fs.renameSync(part, opts.destPath)
    return { destPath: opts.destPath, local: false, size: 11 }
  }
}

export const errorsIn = (events) => events.filter((e) => e[0] === 'error').map((e) => e[1])
