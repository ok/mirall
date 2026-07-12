import test from 'brittle'
// owned-folders imports bare-fs, so this unit test runs under brittle-bare even
// though shouldIgnore itself is pure logic.
import { shouldIgnore, DEFAULT_IGNORE } from '../../src/shared/folders/owned-folders.js'

test('DEFAULT_IGNORE: exact basename matches', (t) => {
  t.ok(shouldIgnore('.DS_Store', DEFAULT_IGNORE))
  t.ok(shouldIgnore('sub/dir/.DS_Store', DEFAULT_IGNORE), 'matches by basename anywhere')
  t.ok(shouldIgnore('Thumbs.db', DEFAULT_IGNORE))
})

test('DEFAULT_IGNORE: suffix globs (*.mirall.part, *~)', (t) => {
  t.ok(shouldIgnore('big.iso.mirall.part', DEFAULT_IGNORE))
  t.ok(shouldIgnore('a/b/download.mirall.part', DEFAULT_IGNORE))
  t.ok(shouldIgnore('notes.txt~', DEFAULT_IGNORE))
  t.absent(shouldIgnore('part.txt', DEFAULT_IGNORE), 'prefix, not suffix → not ignored')
  t.absent(shouldIgnore('big.iso.part', DEFAULT_IGNORE), "another app's .part is not ours to ignore")
})

test('DEFAULT_IGNORE: dir/** prefix globs', (t) => {
  t.ok(shouldIgnore('.git', DEFAULT_IGNORE), 'the dir itself')
  t.ok(shouldIgnore('.git/config', DEFAULT_IGNORE))
  t.ok(shouldIgnore('node_modules/pkg/index.js', DEFAULT_IGNORE))
  t.absent(shouldIgnore('src/.gitignore', DEFAULT_IGNORE), '.gitignore is not .git/**')
  t.absent(shouldIgnore('my-node_modules-notes.md', DEFAULT_IGNORE))
})

test('shouldIgnore: ordinary files pass through', (t) => {
  t.absent(shouldIgnore('keep.txt', DEFAULT_IGNORE))
  t.absent(shouldIgnore('docs/readme.md', DEFAULT_IGNORE))
})

test('shouldIgnore: empty/missing patterns ignore nothing', (t) => {
  t.absent(shouldIgnore('.DS_Store', []))
  t.absent(shouldIgnore('.DS_Store', undefined))
})
