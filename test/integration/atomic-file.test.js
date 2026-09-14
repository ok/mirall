import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { writeFileAtomic } from '../../src/shared/core/atomic-file.js'
import { tmpDir } from '../helpers/bare-tmp.js'

test('writeFileAtomic writes the bytes and leaves no temp file', async (t) => {
  const dir = tmpDir('atomic-write')
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const file = path.join(dir, 'x.bin')

  await writeFileAtomic(file, b4a.from('hello'))
  t.is(b4a.toString(fs.readFileSync(file)), 'hello', 'bytes written')
  t.absent(fs.existsSync(file + '.tmp'), 'no temp file left behind')
})

test('writeFileAtomic overwrites an existing file', async (t) => {
  const dir = tmpDir('atomic-overwrite')
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  const file = path.join(dir, 'x.bin')

  await writeFileAtomic(file, b4a.from('one'))
  await writeFileAtomic(file, b4a.from('two'))
  t.is(b4a.toString(fs.readFileSync(file)), 'two', 'second write replaced the first')
})
