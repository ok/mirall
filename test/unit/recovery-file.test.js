import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import mod from '../../src/main/recovery-file.js'

const { saveRecoveryFile, openRecoveryFile } = mod
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-file-'))
const FILE = { fileName: 'mirall-recovery-2026-09-29.mirallkey', content: '{"type":"mirall-recovery-key"}' }

test('save writes the sealed text where the user chose, owner-only', async (t) => {
  const dir = tmp()
  const target = path.join(dir, 'chosen.mirallkey')
  let offered = null
  const showSaveDialog = async (_win, opts) => { offered = opts; return { canceled: false, filePath: target } }
  t.alike(await saveRecoveryFile(null, FILE, { showSaveDialog, documentsDir: () => dir }), { saved: true })
  t.is(offered.defaultPath, path.join(dir, FILE.fileName), 'suggested in Documents under its own name')
  t.is(fs.readFileSync(target, 'utf-8'), FILE.content)
  if (process.platform !== 'win32') t.is(fs.statSync(target).mode & 0o777, 0o600)
})

test('a cancelled save writes nothing', async (t) => {
  const showSaveDialog = async () => ({ canceled: true, filePath: '' })
  t.alike(await saveRecoveryFile(null, FILE, { showSaveDialog, documentsDir: tmp }), { saved: false })
})

test('save refuses anything that is not a recovery key file', async (t) => {
  const showSaveDialog = async () => t.fail('never asks')
  await t.exception(saveRecoveryFile(null, { ...FILE, fileName: '../evil.mirallkey' }, { showSaveDialog, documentsDir: tmp }))
  await t.exception(saveRecoveryFile(null, { ...FILE, fileName: 'key.txt' }, { showSaveDialog, documentsDir: tmp }))
  await t.exception(saveRecoveryFile(null, { ...FILE, content: 'x'.repeat(70000) }, { showSaveDialog, documentsDir: tmp }))
})

test('open returns the chosen file, and says why it returns none', async (t) => {
  const dir = tmp()
  const file = path.join(dir, 'mine.mirallkey')
  fs.writeFileSync(file, FILE.content)
  const pick = (filePaths) => async () => ({ canceled: filePaths.length === 0, filePaths })
  t.alike(await openRecoveryFile(null, { showOpenDialog: pick([file]) }), { ok: true, fileName: 'mine.mirallkey', content: FILE.content })
  t.alike(await openRecoveryFile(null, { showOpenDialog: pick([]) }), { ok: false, reason: 'cancelled' })

  const big = path.join(dir, 'big.mirallkey')
  fs.writeFileSync(big, 'x'.repeat(70000))
  t.alike(await openRecoveryFile(null, { showOpenDialog: pick([big]) }), { ok: false, reason: 'too-large' })
})
