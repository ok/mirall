import test from 'brittle'
import { contentPath, contentHashOf } from '../../src/shared/transfer/backends/overlay/engine/content-path.js'

test('a content hash round-trips through its synthetic path', (t) => {
  const h = 'ab'.repeat(32)
  t.is(contentPath(h), 'content:' + h)
  t.is(contentHashOf(contentPath(h)), h)
})

test('any other path names no content hash', (t) => {
  for (const p of ['/mir/' + 'ab'.repeat(32), 'contents:x', '', null, undefined]) t.is(contentHashOf(p), null, String(p))
})
