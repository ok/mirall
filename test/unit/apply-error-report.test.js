import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { redactLine } from '../../src/shared/core/diagnostics-redact.js'

const require = createRequire(import.meta.url)
const { applyErrorPath, recordApplyError, clearApplyError, readLiveApplyError } =
  require('../../src/main/apply-error.js')

const VERSION = '1.10.1'

function tmpDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-apply-'))
  t.teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function plant(dir, record) {
  const file = applyErrorPath(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record))
  return file
}

test('no record on disk reports null, so the bundle can leave the key out entirely', (t) => {
  t.is(readLiveApplyError(tmpDataDir(t), { version: VERSION, redactLine }), null)
})

test('a record from the running version is reported', (t) => {
  const dir = tmpDataDir(t)
  recordApplyError(dir, new Error('addPackage failed'), { version: VERSION, platform: 'win32' })

  const report = readLiveApplyError(dir, { version: VERSION, redactLine: null })
  t.is(report.version, VERSION)
  t.is(report.platform, 'win32')
  t.is(report.message, 'addPackage failed')
  t.ok(typeof report.timestamp === 'string' && report.timestamp.length > 0)
  t.ok(fs.existsSync(applyErrorPath(dir)), 'a live record is left on disk')
})

test('a record from a different version is omitted, but held rather than deleted', (t) => {
  // The version gate alone is what keeps it out of the bundle, so the read has no reason to
  // delete — and a read that deletes would destroy the evidence during the very export that
  // exists to carry it.
  const dir = tmpDataDir(t)
  plant(dir, { timestamp: '2026-01-01T00:00:00.000Z', version: '1.9.0', platform: 'win32', message: 'old', stack: null })

  t.is(readLiveApplyError(dir, { version: VERSION, redactLine }), null, 'not reported')
  t.ok(fs.existsSync(applyErrorPath(dir)), 'and not thrown away either')
})

test('a user who downgrades to work around a failed apply keeps the record', (t) => {
  // 1.10.1 fails to apply; the user reinstalls 1.9.0 to get working again. The failure is still
  // unresolved. Exporting a bundle on 1.9.0 must not be what erases it.
  const dir = tmpDataDir(t)
  recordApplyError(dir, new Error('addPackage failed'), { version: VERSION, platform: 'win32' })

  t.is(readLiveApplyError(dir, { version: '1.9.0', redactLine }), null, 'silent on the older build')
  t.is(readLiveApplyError(dir, { version: '1.9.0', redactLine }), null, 'and on a second export')
  t.is(readLiveApplyError(dir, { version: VERSION, redactLine }).message, 'addPackage failed',
    'reportable again the moment they return to the version it names')
})

test('only the writers mutate the file', (t) => {
  const dir = tmpDataDir(t)
  recordApplyError(dir, new Error('x'), { version: VERSION, platform: 'darwin' })
  const before = fs.readFileSync(applyErrorPath(dir), 'utf8')

  readLiveApplyError(dir, { version: VERSION, redactLine })
  readLiveApplyError(dir, { version: 'other', redactLine })
  t.is(fs.readFileSync(applyErrorPath(dir), 'utf8'), before, 'reads left it byte-identical')

  clearApplyError(dir)
  t.absent(fs.existsSync(applyErrorPath(dir)), 'the writer is what removes it')
})

test('a record from the running version is reported however old it is', (t) => {
  // No age cut-off on purpose: a failure from three weeks ago that this build still has not got
  // past is not stale, it is the report.
  const dir = tmpDataDir(t)
  plant(dir, {
    timestamp: '2020-05-01T00:00:00.000Z',
    version: VERSION,
    platform: 'linux',
    message: 'chmod staged AppImage failed',
    stack: null,
  })
  t.is(readLiveApplyError(dir, { version: VERSION, redactLine }).message, 'chmod staged AppImage failed')
})

test('the stack is redacted line by line, and no absolute path survives', (t) => {
  const dir = tmpDataDir(t)
  const stack = [
    'Error: Cannot find module \'msix-manager\'',
    '    at /Users/someone/Library/Application Support/Mirall/app.asar/index.js:1:1',
    '    at C:\\Users\\someone\\AppData\\Local\\Mirall\\main.js:2:2',
  ].join('\n')
  plant(dir, { timestamp: 't', version: VERSION, platform: 'win32', message: 'failed at /Users/someone/x/y', stack })

  const report = readLiveApplyError(dir, { version: VERSION, redactLine })
  t.absent(report.stack.includes('/Users/someone'), 'the POSIX home is gone')
  t.absent(report.stack.includes('C:\\Users\\someone'), 'and the Windows one')
  t.is(report.stack.split('\n').length, 3, 'the shape of the stack is kept')
  t.ok(report.stack.includes('‹path›'), 'replaced rather than dropped')
  t.absent(report.message.includes('/Users/someone'), 'the message is redacted too')
})

test('a record with no stack reports null rather than a string "null"', (t) => {
  const dir = tmpDataDir(t)
  recordApplyError(dir, 'a thrown string', { version: VERSION, platform: 'darwin' })
  const report = readLiveApplyError(dir, { version: VERSION, redactLine })
  t.is(report.stack, null)
  t.is(report.message, 'a thrown string')
})

test('a corrupt or truncated record is omitted rather than thrown', (t) => {
  const dir = tmpDataDir(t)
  plant(dir, '{"version": "1.10.1", "mess')
  t.is(readLiveApplyError(dir, { version: VERSION, redactLine }), null)
  // The next recordApplyError overwrites it; nothing else needs to.
  t.execution(() => readLiveApplyError(dir, { version: VERSION, redactLine }))
})

test('a record that is not an object is refused', (t) => {
  for (const junk of ['null', '"a string"', '[{"version":"1.10.1"}]', '42']) {
    const dir = tmpDataDir(t)
    plant(dir, junk)
    t.is(readLiveApplyError(dir, { version: VERSION, redactLine }), null, junk)
  }
})

test('unexpected fields on disk do not reach the bundle', (t) => {
  // The file is on disk and a user could have edited it; the bundle is something they hand to a
  // stranger. Only the fields the report declares are carried across.
  const dir = tmpDataDir(t)
  plant(dir, {
    timestamp: 't', version: VERSION, platform: 'darwin', message: 'm', stack: null,
    identityKey: 'deadbeef'.repeat(8),
  })
  const report = readLiveApplyError(dir, { version: VERSION, redactLine })
  t.alike(Object.keys(report).sort(), ['message', 'platform', 'stack', 'timestamp', 'version'])
})

test('clearApplyError removes a live record and is safe when there is none', (t) => {
  const dir = tmpDataDir(t)
  recordApplyError(dir, new Error('x'), { version: VERSION, platform: 'darwin' })
  clearApplyError(dir)
  t.absent(fs.existsSync(applyErrorPath(dir)))
  t.execution(() => clearApplyError(dir), 'clearing twice is fine')
})

test('recording into an unwritable data dir does not throw at the caller', (t) => {
  // It runs inside the updater's own catch block; throwing here would replace the real apply
  // failure with a filesystem one.
  t.execution(() => {
    recordApplyError('/proc/nonexistent-mirall', new Error('x'), { version: VERSION, platform: 'linux' })
  })
})
