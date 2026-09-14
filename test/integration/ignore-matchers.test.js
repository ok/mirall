import test from 'brittle'
import { shouldIgnore, shouldPruneDir, DEFAULT_IGNORE } from '../../src/shared/folders/path-keys.js'

test('DEFAULT_IGNORE: exact basename matches', (t) => {
  t.ok(shouldIgnore('.DS_Store', DEFAULT_IGNORE))
  t.ok(shouldIgnore('sub/dir/.DS_Store', DEFAULT_IGNORE), 'matches by basename anywhere')
  t.ok(shouldIgnore('Thumbs.db', DEFAULT_IGNORE))
})

test('DEFAULT_IGNORE: our own partials, at any depth', (t) => {
  t.ok(shouldIgnore('big.iso.mirall.part', DEFAULT_IGNORE))
  t.ok(shouldIgnore('a/b/download.mirall.part', DEFAULT_IGNORE))
  t.absent(shouldIgnore('part.txt', DEFAULT_IGNORE), 'prefix, not suffix → not ignored')
  t.absent(shouldIgnore('big.iso.part', DEFAULT_IGNORE), "another app's .part is not ours to ignore")
})

test('DEFAULT_IGNORE: a folder publishes its own contents, tooling included', (t) => {
  t.absent(shouldIgnore('.git/config', DEFAULT_IGNORE))
  t.absent(shouldIgnore('sub/.git/HEAD', DEFAULT_IGNORE))
  t.absent(shouldIgnore('node_modules/pkg/index.js', DEFAULT_IGNORE))
  t.absent(shouldIgnore('notes.txt~', DEFAULT_IGNORE))
})

test('shouldIgnore: ordinary files pass through', (t) => {
  t.absent(shouldIgnore('keep.txt', DEFAULT_IGNORE))
  t.absent(shouldIgnore('docs/readme.md', DEFAULT_IGNORE))
})

test('shouldIgnore: empty/missing patterns ignore nothing', (t) => {
  t.absent(shouldIgnore('.DS_Store', []))
  t.absent(shouldIgnore('.DS_Store', undefined))
})

test('the walk skips the same directory trees chokidar does', (t) => {
  const patterns = ['node_modules/', '.git/']
  for (const dir of ['node_modules', 'src/node_modules', '.git', 'sub/.git']) {
    t.ok(shouldPruneDir(dir, patterns), 'the walk does not descend into it')
    t.ok(shouldIgnore(dir + '/any.txt', patterns), 'and the watcher withholds what is under it')
  }
})
