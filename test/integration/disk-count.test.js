import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { countDiskFiles, walkDisk } from '../../src/shared/folders/walk-disk.js'
import { DEFAULT_IGNORE } from '../../src/shared/folders/path-keys.js'

const srcRoot = path.join(path.dirname(import.meta.url.replace(/^file:\/\//, '')), '..', '..', 'src')

function tree (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-disk-count-'))
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  fs.mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'a')
  fs.writeFileSync(path.join(root, 'nested', 'b.txt'), 'b')
  fs.writeFileSync(path.join(root, 'nested', 'deeper', 'c.txt'), 'c')
  return root
}

test('it counts every file the walk would see, and nothing else', async (t) => {
  const root = tree(t)
  fs.mkdirSync(path.join(root, 'empty-dir'))

  t.is(await countDiskFiles(root, DEFAULT_IGNORE), 3, 'nested files counted, directories not')
  const walk = await walkDisk(root, DEFAULT_IGNORE)
  t.is(await countDiskFiles(root, DEFAULT_IGNORE), walk.onDisk.size,
    'the two agree on a healthy tree — they share one key rule, so a file counted as already at the destination is a file the walk would sync')
})

test('it applies the ignore list, so hidden OS junk is not reported as user content', async (t) => {
  const root = tree(t)
  fs.writeFileSync(path.join(root, '.DS_Store'), 'junk')
  fs.writeFileSync(path.join(root, 'nested', '.DS_Store'), 'junk')

  t.is(await countDiskFiles(root, DEFAULT_IGNORE), 3,
    'a folder the user has merely viewed does not report a phantom extra file')
  t.is(await countDiskFiles(root, []), 5, 'and the ignore list is the caller\'s to choose')
})

test('an unreadable destination rejects rather than reporting a false zero', async (t) => {
  await t.exception(() => countDiskFiles(path.join(os.tmpdir(), 'mirall-no-such-dir-' + Date.now()), DEFAULT_IGNORE))
})

// REGRESSION (FIX-PREVIEW-STAT: the mount preview's "already at the destination" count was moved
// onto walkDisk, which stats every file. The preview runs on the worker's only thread while the
// user waits in a dialog, and statSync is blocking — so a large destination folder stalled the
// whole data layer to produce a number that needs no file metadata at all.)
test('REGRESSION (FIX-PREVIEW-STAT): the count reads no file metadata', (t) => {
  const src = fs.readFileSync(path.join(srcRoot, 'shared', 'folders', 'walk-disk.js'), 'utf8')
  const from = src.indexOf('export async function countDiskFiles')
  const body = src.slice(from, src.indexOf('\n}', from))
  t.ok(from > 0, 'found the counter')
  t.absent(/stat/i.test(body), 'it stats nothing — the count answers "how many", never "how big"')

  const preview = fs.readFileSync(path.join(srcRoot, 'shared', 'folders', 'foreign-preview.js'), 'utf8')
  t.absent(/walkDisk/.test(preview), 'and the mount preview does not reach for the stat-ing walk to get it')
})
