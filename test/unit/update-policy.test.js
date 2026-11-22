// The update mode's decisions, without a drive: when a pass reads the offered version, what it does
// with it, and which staged version may install. test/raw/update-mode.test.js runs the same policy
// as the hook of a real updater.
import test from 'brittle'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createUpdatePolicy, needsRead, passDecision } = require('../../src/main/update-policy.js')

test('only never skips the read, and only for a pass nobody asked for', (t) => {
  t.ok(needsRead({ mode: 'automatic', manual: false, approved: null }))
  t.ok(needsRead({ mode: 'notify', manual: false, approved: null }))
  t.absent(needsRead({ mode: 'never', manual: false, approved: null }))
  t.ok(needsRead({ mode: 'never', manual: true, approved: null }), 'Check now')
  t.ok(needsRead({ mode: 'never', manual: false, approved: '2.0.0' }), 'an approved download')
})

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
  t.absent(policy.mayInstall('2.0.0'), 'switched off after it downloaded')
  policy.approve('2.0.0')
  t.ok(policy.mayInstall('2.0.0'))
  t.absent(policy.mayInstall('2.1.0'), 'approval names a version')
  t.absent(policy.mayInstall(null), 'an unnamed download is not the approved one')
})

test('an unknown stored mode reads as automatic', (t) => {
  t.is(createUpdatePolicy({ running: '1.0.0', getMode: () => 'sometimes' }).mode(), 'automatic')
  t.is(createUpdatePolicy({ running: '1.0.0', getMode: () => undefined }).mode(), 'automatic')
})

test('in automatic mode the gate never reads the drive', async (t) => {
  const policy = createUpdatePolicy({ running: '1.0.0', getMode: () => 'automatic' })
  const drive = { update: () => t.fail('read the drive') }
  t.is(await policy.gate(drive, { manual: false }), null)
})

test('in never mode a background pass is stopped before it touches the drive', async (t) => {
  const policy = createUpdatePolicy({ running: '1.0.0', getMode: () => 'never' })
  const drive = { update: () => t.fail('read the drive') }
  t.alike(await policy.gate(drive, { manual: false }), { skip: true, available: undefined })
})

// The renderer writes the general preferences back whole from its own copy, so a mode stored there
// would be overwritten by the next unrelated toggle. main.js wires the updater to the mode's own group.
test('main reads and writes the mode in its own config group', (t) => {
  const src = fs.readFileSync(new URL('../../src/main/main.js', import.meta.url), 'utf8')
  t.ok(src.includes("getUpdateMode: () => config().get('updates.mode')"), 'read from updates.mode')
  t.ok(src.includes("setUpdateMode: (mode) => config().set('updates.mode', mode)"), 'written to updates.mode')
})
