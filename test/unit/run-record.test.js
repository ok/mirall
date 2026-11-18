import test from 'brittle'
import { parseRunRecord, serializeRunRecord, RUN_RECORD_FILE } from '../../src/shared/contract/run-record.js'

const good = { v: 1, socket: '/p/run/daemon.sock', pid: 4242, version: '1.14.0' }

test('a record reads back what was written, and the file has one fixed name', (t) => {
  t.is(RUN_RECORD_FILE, 'daemon.json')
  t.alike(parseRunRecord(serializeRunRecord(good)), good)
  t.alike(Object.keys(JSON.parse(serializeRunRecord(good))), ['v', 'socket', 'pid', 'version'])
})

test('anything that is not JSON is no record', (t) => {
  for (const text of ['', '{', 'null', '[]', '"x"', '42', '{"v":1']) t.is(parseRunRecord(text), null, JSON.stringify(text))
})

test('a record with a missing or wrong-typed field is no record', (t) => {
  for (const key of Object.keys(good)) {
    const { [key]: _gone, ...rest } = good
    t.is(parseRunRecord(JSON.stringify(rest)), null, 'missing ' + key)
  }
  const bad = [{ socket: 7 }, { socket: '' }, { pid: '4242' }, { pid: 0 }, { pid: -3 }, { pid: 1.5 }, { version: 1 }, { version: '' }]
  for (const change of bad) t.is(parseRunRecord(JSON.stringify({ ...good, ...change })), null, JSON.stringify(change))
})

test('a record of another version is no record', (t) => {
  for (const v of [0, 2, '1', null]) t.is(parseRunRecord(JSON.stringify({ ...good, v })), null, String(v))
})

test('unknown extra fields are dropped from what is returned', (t) => {
  t.alike(parseRunRecord(JSON.stringify({ ...good, extra: true })), good)
})
