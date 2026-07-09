import test from 'brittle'
import { formatInviteCode, parseInviteCode } from '../../src/shared/spaces/space.js'

const HEX64 = 'a'.repeat(8) + 'b'.repeat(8) + 'c'.repeat(8) + 'd'.repeat(8) +
              'e'.repeat(8) + 'f'.repeat(8) + '0'.repeat(8) + '1'.repeat(8)

test('formatInviteCode groups a 64-hex topic into 8 dash-separated octets', (t) => {
  const code = formatInviteCode(HEX64)
  const parts = code.split('-')
  t.is(parts.length, 8)
  t.ok(parts.every((p) => p.length === 8))
  t.is(parts.join(''), HEX64)
})

test('parseInviteCode strips dashes', (t) => {
  t.is(parseInviteCode('aaaaaaaa-bbbbbbbb'), 'aaaaaaaabbbbbbbb')
  t.is(parseInviteCode('nodashes'), 'nodashes')
})

test('parse(format(x)) is identity for a topic hex', (t) => {
  t.is(parseInviteCode(formatInviteCode(HEX64)), HEX64)
})

test('non-multiple-of-8 length keeps a short trailing group and round-trips', (t) => {
  const odd = 'abcdefghij' // 10 chars → ['abcdefgh','ij']
  t.is(formatInviteCode(odd), 'abcdefgh-ij')
  t.is(parseInviteCode(formatInviteCode(odd)), odd)
})
