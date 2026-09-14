import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(path.resolve(here, '../../src', p), 'utf8')

// Both previews feed one renderer component, and both used to hand-build their result object.
// Source-scanned rather than imported: both modules import bare-fs/bare-path, so a Node runner
// cannot load them. The promise is narrow but exactly the one that broke before — one flow's
// contract fields drifting from the other's.
for (const file of ['shared/folders/owned-preview.js', 'shared/folders/foreign-preview.js']) {
  test(`${file} builds its result through the shared tally`, (t) => {
    const src = read(file)
    t.ok(/createPreviewTally/.test(src), 'it uses the shared accumulator')
    t.absent(/perFileOmitted\s*:/.test(src), 'and does not hand-roll the contract fields')
    t.absent(/toUpload\s*:/.test(src), 'nor the direction fields')
    t.absent(/toDownload\s*:/.test(src))
  })
}

// The layering rule from testing.md, pinned: these must stay Node-loadable, or the unit tests
// above them silently belong to a different runner.
for (const file of [
  'shared/folders/preview-tally.js',
  'shared/folders/preview-detail.js',
  'shared/folders/path-keys.js',
  'shared/transfer/partial-suffix.js',
]) {
  test(`${file} imports no bare-* module`, (t) => {
    t.absent(/from '(bare-[a-z]+)'/.test(read(file)), 'stays unit-testable under Node')
  })
}
