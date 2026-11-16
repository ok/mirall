import test from 'brittle'
import { loadWithFakeElectron } from '../helpers/fake-electron.js'

// "Try again" on the locked screen: recover a set-aside key if the keychain can open one, then hand
// the running worker the key held now. No restart: the answer is whether the identity opened.
function setup({ recovered = null, opens = false } = {}) {
  const { electron, modules } = loadWithFakeElectron(['src/main/identity-retry.js'])
  const calls = []
  let held = 'minted'
  modules[0].registerIdentityRetry({
    recoverKEK: () => { calls.push('recover'); return recovered },
    adoptKEK: (kek) => { calls.push('adopt'); held = kek },
    retryUnlock: async () => { calls.push('unlock:' + held); if (opens instanceof Error) throw opens; return opens },
  })
  return { call: () => electron.ipcMain.handlers.get('identity:retry-unlock')({}), calls }
}

test('a recovered key is adopted before the worker is handed the key it now holds', async (t) => {
  const { call, calls } = setup({ recovered: 'original', opens: true })
  t.is(await call(), true)
  t.alike(calls, ['recover', 'adopt', 'unlock:original'])
})

test('with nothing to recover the worker is still handed the current key, and a lock again is false', async (t) => {
  const { call, calls } = setup({ recovered: null, opens: false })
  t.is(await call(), false)
  t.alike(calls, ['recover', 'unlock:minted'])
})

test('a worker that cannot be reached is an error the screen can say', async (t) => {
  const { call } = setup({ opens: new Error('no worker is running') })
  await t.exception(call())
})
