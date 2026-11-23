// The update mode's decisions, without a drive: what a pass does with the offered version, and which
// staged version may install. test/raw/update-mode.test.js runs the same policy behind a real updater.
import test from 'brittle'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createUpdatePolicy, passDecision } = require('../../src/main/update-policy.js')

test('a newer version is reported and not downloaded', (t) => {
  t.alike(passDecision({ remote: '2.0.0', running: '1.0.0', approved: null }), { skip: true, available: '2.0.0' })
})

test('the approved version downloads, and only that one', (t) => {
  t.alike(passDecision({ remote: '2.0.0', running: '1.0.0', approved: '2.0.0' }), { skip: false, available: '2.0.0' })
  t.alike(passDecision({ remote: '2.1.0', running: '1.0.0', approved: '2.0.0' }), { skip: true, available: '2.1.0' }, 'a newer one asks again')
})

test('nothing newer is nothing to report', (t) => {
  for (const remote of ['1.0.0', '0.9.0', '1.0.0-beta.3', null, 'not-a-version']) {
    t.alike(passDecision({ remote, running: '1.0.0', approved: null }), { skip: true, available: null }, String(remote))
  }
  t.alike(passDecision({ remote: '1.0.0', running: '1.0.0-beta.3', approved: null }), { skip: true, available: '1.0.0' }, 'a release after its beta')
})

test('a staged update installs in automatic mode, otherwise only once approved', (t) => {
  let mode = 'automatic'
  const policy = createUpdatePolicy({ running: '1.0.0', getMode: () => mode })
  t.ok(policy.mayInstall('2.0.0'))
  mode = 'notify'
  t.absent(policy.mayInstall('2.0.0'), 'switched to notify after it downloaded')
  policy.approve('2.0.0')
  t.ok(policy.mayInstall('2.0.0'))
  t.absent(policy.mayInstall('2.1.0'), 'approval names a version')
  t.absent(policy.mayInstall(null), 'an unnamed download is not the approved one')
})

test('an unknown stored mode reads as automatic', (t) => {
  t.is(createUpdatePolicy({ running: '1.0.0', getMode: () => 'sometimes' }).mode(), 'automatic')
  t.is(createUpdatePolicy({ running: '1.0.0', getMode: () => 'never' }).mode(), 'automatic', 'there is no mode that stops looking')
  t.is(createUpdatePolicy({ running: '1.0.0', getMode: () => undefined }).mode(), 'automatic')
})

test('in automatic mode the gate never reads the drive', async (t) => {
  const policy = createUpdatePolicy({ running: '1.0.0', getMode: () => 'automatic' })
  const drive = { update: () => t.fail('read the drive') }
  t.is(await policy.gate(drive), null)
})
