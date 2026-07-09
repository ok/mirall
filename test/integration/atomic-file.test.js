import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { writeFileAtomic } from '../../src/shared/core/atomic-file.js'

function tmp (label) {
  const dir = path.join(os.tmpdir(), `atomic-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('writeFileAtomic writes the bytes and leaves no temp file', async (t) => {
  const dir = tmp('write')
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const file = path.join(dir, 'x.bin')

  await writeFileAtomic(file, b4a.from('hello'))
  t.is(b4a.toString(fs.readFileSync(file)), 'hello', 'bytes written')
  t.absent(fs.existsSync(file + '.tmp'), 'no temp file left behind')
})

test('writeFileAtomic overwrites an existing file', async (t) => {
  const dir = tmp('overwrite')
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const file = path.join(dir, 'x.bin')

  await writeFileAtomic(file, b4a.from('one'))
  await writeFileAtomic(file, b4a.from('two'))
  t.is(b4a.toString(fs.readFileSync(file)), 'two', 'second write replaced the first')
})
