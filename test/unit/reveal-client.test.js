import test from 'brittle'
import { revealOnClient } from '../../src/renderer/platform/reveal-client.js'
import { CODES } from '../../src/shared/contract/errors.js'

// The renderer carries the worker's answer to main's shell gate. It never re-tags the path, and a
// refusal reaches useRunAction as a coded rejection so the toast reads the gate's sentence.
const target = { path: '/Volumes/Data/dl/report.pdf', exists: true, host: 'daemon' }

async function codeOf(fn) {
  try { await fn(); return null } catch (err) { return err.code }
}

test('hands the worker answer to the shell gate unchanged', async (t) => {
  const calls = []
  await revealOnClient(target, { showInFolder: async (x) => { calls.push(x); return { ok: true } } })
  t.alike(calls, [target], 'path, exists and host travel as answered')
})

test('a refusal rejects with the gate code', async (t) => {
  t.is(await codeOf(() => revealOnClient(target, { showInFolder: async () => ({ ok: false, code: 'REVEAL_REFUSED' }) })),
    CODES.REVEAL_REFUSED)
})

test('a refusal with no code still carries one', async (t) => {
  t.is(await codeOf(() => revealOnClient(target, { showInFolder: async () => ({ ok: false }) })), CODES.REVEAL_REFUSED)
  t.is(await codeOf(() => revealOnClient(target, { showInFolder: async () => undefined })), CODES.REVEAL_REFUSED,
    'a bridge that answered nothing is a refusal, not a success')
})
