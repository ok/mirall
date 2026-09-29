import test from 'brittle'
import { requireHost } from '../../src/shared/core/client-trust.js'
import { TRUST } from '../../src/shared/contract/ipc-frames.js'

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
