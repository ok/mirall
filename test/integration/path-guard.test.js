// Focused coverage for the shared mount-relative path guard in
// src/shared/transfer/path-guard.js, imported by the overlay backend and
// worker/main.js pathFromMount. bare-path is Bare-only, so this lives in the
// integration tier; this asserts the primitive directly.
import test from 'brittle'
import path from 'bare-path'
import { pathFromMount } from '../../src/shared/transfer/path-guard.js'

const MOUNT = path.join(path.sep + 'tmp', 'mirall-mount')

test('pathFromMount — accepts normal in-mount relPaths', (t) => {
  t.is(pathFromMount(MOUNT, 'file.txt'), path.join(MOUNT, 'file.txt'))
  t.is(pathFromMount(MOUNT, 'a/b/c.bin'), path.join(MOUNT, 'a', 'b', 'c.bin'))
  t.is(pathFromMount(MOUNT, 'deeply/nested/dir/leaf'), path.join(MOUNT, 'deeply', 'nested', 'dir', 'leaf'))
})

test('pathFromMount — rejects parent traversal', (t) => {
  t.exception(() => pathFromMount(MOUNT, '../escape'))
  t.exception(() => pathFromMount(MOUNT, 'a/../../etc/passwd'))
  t.exception(() => pathFromMount(MOUNT, '..'))
})

test('pathFromMount — rejects absolute paths', (t) => {
  t.exception(() => pathFromMount(MOUNT, '/etc/passwd'))
  t.exception(() => pathFromMount(MOUNT, path.join(path.sep + 'abs', 'path')))
})

test('pathFromMount — rejects empty + dot segments', (t) => {
  t.exception(() => pathFromMount(MOUNT, ''))
  t.exception(() => pathFromMount(MOUNT, 'a//b'))   // empty middle segment
  t.exception(() => pathFromMount(MOUNT, 'a/./b'))  // single-dot segment
})

test('pathFromMount — rejects backslash segments (Windows-style escape)', (t) => {
  t.exception(() => pathFromMount(MOUNT, 'a\\..\\b'))
  t.exception(() => pathFromMount(MOUNT, 'dir\\file.txt'))
})

test('pathFromMount — result always stays under the mount', (t) => {
  const abs = pathFromMount(MOUNT, 'sub/leaf.txt')
  const rel = path.relative(MOUNT, abs)
  t.absent(rel.startsWith('..'), 'resolved path does not escape the mount')
  t.absent(path.isAbsolute(rel), 'resolved path is inside the mount')
})
