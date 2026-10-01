// One part of a core's backed-up range: a header naming the core and range, then its proof records,
// each length-prefixed. A range too large for one part continues in the next, always at a record
// boundary, and the last part says so; parts are applied in order.
import b4a from 'b4a'
import { AppError } from '../../core/errors.js'
import { CODES } from '../../contract/errors.js'

const MAGIC = b4a.from('MBSG')
const VERSION = 1
const PREFIX = MAGIC.length + 1 + 4

export const DEFAULT_PART_BYTES = 4 * 1024 * 1024

function u32(n) {
  const out = b4a.alloc(4)
  new DataView(out.buffer, out.byteOffset, 4).setUint32(0, n, true)
  return out
}

function readU32(buf, at) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(at, true)
}

export function encodePart(header, records) {
  const head = b4a.from(JSON.stringify(header))
  const chunks = [MAGIC, b4a.from([VERSION]), u32(head.byteLength), head]
  for (const record of records) chunks.push(u32(record.byteLength), record)
  return b4a.concat(chunks)
}

const corrupt = (why) => new AppError(CODES.BACKUP_CORRUPT, `segment: ${why}`)

function parseHeader(bytes) {
  try {
    const header = JSON.parse(b4a.toString(bytes))
    if (header && typeof header === 'object') return header
  } catch {}
  throw corrupt('unreadable header')
}

export function decodePart(buf) {
  if (buf.byteLength < PREFIX || !b4a.equals(buf.subarray(0, MAGIC.length), MAGIC)) throw corrupt('not a backup part')
  if (buf[MAGIC.length] !== VERSION) throw corrupt(`unsupported version ${buf[MAGIC.length]}`)
  const headLength = readU32(buf, MAGIC.length + 1)
  let at = PREFIX + headLength
  if (at > buf.byteLength) throw corrupt('truncated header')
  const header = parseHeader(buf.subarray(PREFIX, at))
  const records = []
  while (at < buf.byteLength) {
    if (at + 4 > buf.byteLength) throw corrupt('truncated record length')
    const length = readU32(buf, at)
    at += 4
    if (at + length > buf.byteLength) throw corrupt('truncated record')
    records.push(buf.subarray(at, at + length))
    at += length
  }
  return { header, records }
}

async function* batches(records, maxBytes) {
  let batch = []
  let size = 0
  for await (const record of records) {
    if (batch.length && size + record.byteLength > maxBytes) {
      yield batch
      batch = []
      size = 0
    }
    batch.push(record)
    size += record.byteLength
  }
  yield batch
}

// Parts of at most `maxBytes` of records each, never splitting one: a record larger than that gets a
// part of its own. Each header carries its part index and whether it is the last.
export async function* encodeParts(header, records, maxBytes = DEFAULT_PART_BYTES) {
  let part = 0
  let pending = null
  for await (const batch of batches(records, maxBytes)) {
    if (pending) yield encodePart({ ...header, part: part++, last: false }, pending)
    pending = batch
  }
  yield encodePart({ ...header, part, last: true }, pending)
}
