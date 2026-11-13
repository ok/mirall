import test from 'brittle'
import { requireHost } from '../../src/shared/core/client-trust.js'
import { TRUST } from '../../src/shared/contract/ipc-frames.js'
import { registerManaged } from '../../src/worker/ipc/managed.js'

test('the host passes and anyone else is refused, with the reason the caller names', (t) => {
  t.execution(() => requireHost({ trust: TRUST.HOST }))
  const other = { trust: 'peer' }
  t.exception(() => requireHost(other), /only the host may stop the worker/, 'the default reason')
  t.exception(() => requireHost(other, 'only the host may export the recovery key'), /export the recovery key/)
  try {
    requireHost(null)
  } catch (err) {
    t.is(err.code, 'NOT_AUTHORIZED')
  }
})

test('joining and leaving an organization are the host\'s alone, and a refused call changes nothing', async (t) => {
  const handlers = new Map()
  const calls = []
  const service = {
    accept: async (code) => { calls.push(['accept', code]); return {} },
    leave: async () => { calls.push(['leave']); return { left: null } }
  }
  registerManaged({ handle: (name, fn) => handlers.set(name, fn) }, { service })
  const peer = { client: { trust: 'peer' } }
  for (const [name, msg] of [['managed:accept', { code: 'C' }], ['managed:leave', {}]]) {
    try {
      await handlers.get(name)(msg, peer)
      t.fail(`${name} let a non-host client through`)
    } catch (err) {
      t.is(err.code, 'NOT_AUTHORIZED', `${name} refuses a non-host client`)
    }
  }
  t.alike(calls, [], 'neither handler reached the service')
  const host = { client: { trust: TRUST.HOST } }
  await handlers.get('managed:accept')({ code: 'C' }, host)
  await handlers.get('managed:leave')({}, host)
  t.alike(calls, [['accept', 'C'], ['leave']], 'the host reaches both')
})
