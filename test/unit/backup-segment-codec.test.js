import test from 'brittle'
import b4a from 'b4a'
import { encodePart, decodePart, encodeParts } from '../../src/shared/storage/backup/segment-codec.js'

const header = { dk: 'ab'.repeat(32), fork: 0, from: 0, to: 3 }
const rec = (n, size = 10) => b4a.alloc(size, n)

async function collect(gen) {
  const out = []
  for await (const part of gen) out.push(decodePart(part))
  return out
}

async function* from(list) { for (const r of list) yield r }

test('a part round-trips its header and records', (t) => {
  const { header: h, records } = decodePart(encodePart({ ...header, part: 0, last: true }, [rec(1), rec(2, 0), rec(3, 300)]))
  t.alike(h, { ...header, part: 0, last: true })
  t.alike(records.map((r) => r.byteLength), [10, 0, 300])
  t.is(records[2][0], 3)
})

test('a part that is not one, from a newer version, or cut short is refused', (t) => {
  const good = encodePart({ ...header, part: 0, last: true }, [rec(1)])
  t.exception(() => decodePart(b4a.from('nope, not a part')), /not a backup part/)
  const newer = b4a.from(good)
  newer[4] = 2
  t.exception(() => decodePart(newer), /unsupported version 2/)
  t.exception(() => decodePart(good.subarray(0, good.byteLength - 3)), /truncated record/)
  t.exception(() => decodePart(good.subarray(0, 12)), /truncated header/)
  const garbled = b4a.from(good)
  garbled[9] = 0x00
  try {
    decodePart(garbled)
    t.fail('a garbled header decoded')
  } catch (err) {
    t.is(err.code, 'BACKUP_CORRUPT', 'every refusal carries the code the restore screen explains')
  }
})

test('parts break only between records, and only the last says so', async (t) => {
  const parts = await collect(encodeParts(header, from([rec(1), rec(2), rec(3), rec(4), rec(5)]), 25))
  t.alike(parts.map((p) => p.records.length), [2, 2, 1])
  t.alike(parts.map((p) => p.header.part), [0, 1, 2])
  t.alike(parts.map((p) => p.header.last), [false, false, true])
  t.alike(parts.flatMap((p) => p.records.map((r) => r[0])), [1, 2, 3, 4, 5], 'every record once, in order')
})

test('a record larger than a part gets a part of its own', async (t) => {
  const parts = await collect(encodeParts(header, from([rec(1), rec(2, 100), rec(3)]), 25))
  t.alike(parts.map((p) => p.records.map((r) => r[0])), [[1], [2], [3]])
})

test('a range with no records is still one, last part', async (t) => {
  const parts = await collect(encodeParts(header, from([]), 25))
  t.is(parts.length, 1)
  t.ok(parts[0].header.last)
  t.is(parts[0].records.length, 0)
})
