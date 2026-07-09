import test from 'brittle'
import { isValidShareName, generateShareId } from '../../src/shared/shares/shares.js'

test('isValidShareName accepts ordinary names', (t) => {
  t.ok(isValidShareName('Notes'))
  t.ok(isValidShareName('My Folder 2024'))
  t.ok(isValidShareName('  trimmed-ok  '), 'leading/trailing space is trimmed, still valid')
  t.ok(isValidShareName('a'.repeat(255)))
})

test('isValidShareName rejects non-strings', (t) => {
  t.absent(isValidShareName(null))
  t.absent(isValidShareName(undefined))
  t.absent(isValidShareName(123))
  t.absent(isValidShareName({}))
})

test('isValidShareName rejects empty / whitespace-only / too long', (t) => {
  t.absent(isValidShareName(''))
  t.absent(isValidShareName('   '))
  t.absent(isValidShareName('a'.repeat(256)))
})

test('isValidShareName rejects illegal path characters and control chars', (t) => {
  for (const ch of ['\\', '/', '<', '>', ':', '"', '|', '?', '*']) {
    t.absent(isValidShareName('bad' + ch + 'name'), 'rejects ' + JSON.stringify(ch))
  }
  t.absent(isValidShareName('null\x00byte'))
  t.absent(isValidShareName('tab\tinside'))
})

test('isValidShareName rejects dot and dot-dot', (t) => {
  t.absent(isValidShareName('.'))
  t.absent(isValidShareName('..'))
  t.ok(isValidShareName('...'), 'three dots is a legal name')
})

test('generateShareId has the documented shape and is unique', (t) => {
  const id = generateShareId()
  t.ok(/^[0-9a-z]+-[0-9a-z]{1,8}$/.test(id), 'matches <base36ts>-<rand>: ' + id)
  const ids = new Set(Array.from({ length: 200 }, () => generateShareId()))
  t.is(ids.size, 200, 'no collisions across 200 ids')
})
