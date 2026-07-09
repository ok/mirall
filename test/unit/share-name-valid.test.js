import test from 'brittle'
import { isValidShareName } from '../../src/renderer/sharePaths.js'

test('rejects empty, over-long, reserved, and illegal-char names', (t) => {
  t.is(isValidShareName(''), false)
  t.is(isValidShareName('   '), false)
  t.is(isValidShareName('a'.repeat(256)), false)
  t.is(isValidShareName('.'), false)
  t.is(isValidShareName('..'), false)
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\x00b']) {
    t.is(isValidShareName(bad), false, bad)
  }
})

test('accepts ordinary folder names (trimmed)', (t) => {
  t.is(isValidShareName('Photos 2026'), true)
  t.is(isValidShareName('  Trip  '), true)
  t.is(isValidShareName('a'.repeat(255)), true)
})
