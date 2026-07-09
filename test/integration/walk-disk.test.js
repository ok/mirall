import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { walkDisk } from '../../src/shared/folders/walk-disk.js'

let seq = 0
function tmp () {
  const dir = path.join(os.tmpdir(), `mirall-walk-${Date.now()}-${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('stat-only walk returns size+mtime and never a hash', async (t) => {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'a.txt'), 'aaaa')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'bb')

  const { onDisk } = await walkDisk(root, [], { hash: false })
  t.is(onDisk.size, 2)
  const a = onDisk.get('a.txt')
  t.is(a.size, 4)
  t.ok(typeof a.mtime === 'number')
  t.absent(a.hash, 'no content hash in stat-only mode')
  t.ok(onDisk.has('sub/b.txt'), 'recurses, posix-joined keys')
})

test('ignore globs are honored', async (t) => {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'keep.txt'), 'k')
  fs.writeFileSync(path.join(root, '.DS_Store'), 'junk')
  const { onDisk } = await walkDisk(root, ['.DS_Store'], { hash: false })
  t.ok(onDisk.has('keep.txt'))
  t.absent(onDisk.has('.DS_Store'))
})

test('onProgress is monotonic and ends at the file count', async (t) => {
  const root = tmp()
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x'.repeat(i + 1))
  const seen = []
  const { onDisk } = await walkDisk(root, [], { hash: false, onProgress: (p) => seen.push(p) })
  t.ok(seen.length >= 1)
  t.is(seen[seen.length - 1].scanned, onDisk.size)
  for (let i = 1; i < seen.length; i++) t.ok(seen[i].scanned >= seen[i - 1].scanned, 'scanned monotonic')
})

test('an aborted signal throws PREVIEW_CANCELLED', async (t) => {
  const root = tmp()
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x')
  try {
    await walkDisk(root, [], { hash: false, signal: { aborted: true } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.code, 'PREVIEW_CANCELLED')
  }
})
