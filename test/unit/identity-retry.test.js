import test from 'brittle'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { loadWithFakeElectron } from '../helpers/fake-electron.js'

// "Try again" on the locked screen: ask the running worker, and only a worker locked on a key that
// could not open the identity gets a recovered key and an unlock. No restart: the answer is whether
// the identity is open.
const enc = (s) => Buffer.from('enc:' + s, 'utf8')
const keychain = { decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, '') }
const MINTED = 'aa'.repeat(32)
const ORIGINAL = 'cc'.repeat(32)

// The key files as a launch over a reset keychain leaves them: a minted kek.enc and the original set aside.
function keyFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-retry-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const storage = path.join(dir, 'app-storage')
  fs.writeFileSync(path.join(dir, 'kek.enc'), enc(MINTED))
  fs.writeFileSync(path.join(dir, 'kek.enc.unreadable-2026-09-29T10-00-00'), enc(ORIGINAL))
  return { dir, storage, listing: () => fs.readdirSync(dir).sort(), kek: () => fs.readFileSync(path.join(dir, 'kek.enc'), 'utf8') }
}

function setup(t, { status, opens = true }) {
  const { electron, modules } = loadWithFakeElectron(['src/main/identity-kek.js', 'src/main/identity-retry.js'])
  const [kekModule, retry] = modules
  const files = keyFiles(t)
  const calls = []
  let held = MINTED
  retry.registerIdentityRetry({
    workerStatus: async () => { calls.push('status'); return status },
    recoverKEK: () => { calls.push('recover'); return kekModule.recoverUnreadableKEK(files.storage, { safeStorage: keychain }) },
    adoptKEK: (kek) => { calls.push('adopt'); held = kek },
    retryUnlock: async () => { calls.push('unlock:' + held.slice(0, 2)); return opens },
  })
  return { call: () => electron.ipcMain.handlers.get('identity:retry-unlock')({}), calls, files }
}

test('a worker locked on a key that could not open it gets the recovered key, then the unlock', async (t) => {
  const { call, calls, files } = setup(t, { status: { locked: true, code: 'IDENTITY_UNLOCK_FAILED' } })
  t.is(await call(), true)
  t.alike(calls, ['status', 'recover', 'adopt', 'unlock:cc'])
  t.is(files.kek(), 'enc:' + ORIGINAL, 'the original key is back in place')
  t.ok(files.listing().some((name) => name.startsWith('kek.enc.unused-')), 'the minted one is kept aside')
})

test('with no better key to recover the worker is still handed the current one, and a lock again is false', async (t) => {
  const { call, calls, files } = setup(t, { status: { locked: true, code: 'IDENTITY_PROVIDER_MISMATCH' }, opens: false })
  fs.rmSync(path.join(files.dir, 'kek.enc.unreadable-2026-09-29T10-00-00'))
  t.is(await call(), false)
  t.alike(calls, ['status', 'recover', 'unlock:aa'])
})

test('REGRESSION (FIX-UNLOCK-4: a stale locked screen swapped the key an open identity is sealed under): a worker that is not locked is left alone, and no key file is touched', async (t) => {
  const { call, calls, files } = setup(t, { status: { locked: false, code: null } })
  const before = files.listing()
  t.is(await call(), true, 'the identity is open')
  t.alike(calls, ['status'], 'no key recovered, nothing sent')
  t.alike(files.listing(), before, 'no file renamed')
  t.is(files.kek(), 'enc:' + MINTED, 'the key the identity is sealed under is the one in place')
})

test('a worker still waiting for a key has nothing to recover: false, and no key file is touched', async (t) => {
  const { call, calls, files } = setup(t, { status: { locked: true, code: 'IDENTITY_AWAITING_KEY' } })
  const before = files.listing()
  t.is(await call(), false)
  t.alike(calls, ['status'])
  t.alike(files.listing(), before)
})

test('a worker that cannot be reached is an error the screen can say', async (t) => {
  const { electron, modules } = loadWithFakeElectron(['src/main/identity-retry.js'])
  modules[0].registerIdentityRetry({ workerStatus: async () => { throw new Error('no worker is running') }, recoverKEK: () => null, adoptKEK() {}, retryUnlock: async () => true })
  await t.exception(electron.ipcMain.handlers.get('identity:retry-unlock')({}))
})
