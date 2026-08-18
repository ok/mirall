import test from 'brittle'
import { agentArgs, ACTION_TIMEOUT_MS } from '../frontend/agent.mjs'
import { agentDesktopTooOld, MIN_AGENT_DESKTOP } from '../frontend/preflight.mjs'
import { findNode } from '../frontend/tree.mjs'

// The frontend AX suite itself is local-only (CI can't drive the AX tree), but
// these two pure helpers gate the agent-desktop upgrade and can run in CI. They
// encode the breaking changes the bumps required: global-flag hoisting
// (--session/--headed precede the subcommand), the per-action auto-wait budget
// 0.5.0 added, and the version floor.

test('agentArgs hoists --session ahead of the subcommand', (t) => {
  t.alike(
    agentArgs(['snapshot', '--window-id', 'w-1', '--max-depth', '40'], { session: 'mirall-owner' }),
    ['--session', 'mirall-owner', 'snapshot', '--window-id', 'w-1', '--max-depth', '40'],
  )
})

test('agentArgs adds --headed for cursor commands (session then headed then args)', (t) => {
  t.alike(
    agentArgs(['hover', '@e1'], { session: 'mirall-peer', headed: true }),
    ['--session', 'mirall-peer', '--headed', 'hover', '@e1', '--timeout-ms', ACTION_TIMEOUT_MS],
  )
})

test('agentArgs is a no-op when no globals are requested', (t) => {
  t.alike(agentArgs(['list-windows']), ['list-windows'])
  t.alike(agentArgs(['press', 'return'], {}), ['press', 'return'])
})

test('agentArgs supports --headed without a session', (t) => {
  t.alike(agentArgs(['mouse-move', '--xy', '5,5'], { headed: true }), ['--headed', 'mouse-move', '--xy', '5,5'])
})

// 0.5.0+ auto-waits for ref resolution and actionability on every ref action, a
// budget that runs BEFORE the activation chain. Left at its 5s default it stacks
// with the chain and with withRetry's re-snapshots, so the harness caps it.
test('agentArgs caps the auto-wait budget on ref actions', (t) => {
  for (const cmd of ['click', 'type', 'focus', 'set-value', 'scroll', 'hover', 'toggle', 'select']) {
    t.alike(agentArgs([cmd, '@e1']), [cmd, '@e1', '--timeout-ms', ACTION_TIMEOUT_MS], cmd)
  }
})

test('agentArgs leaves a caller-supplied --timeout-ms alone', (t) => {
  t.alike(agentArgs(['click', '@e1', '--timeout-ms', '9000']), ['click', '@e1', '--timeout-ms', '9000'])
})

test('agentArgs adds no auto-wait budget to subcommands that reject the flag', (t) => {
  for (const argv of [['snapshot'], ['list-windows'], ['press', 'return'], ['mouse-move', '--xy', '5,5'], ['screenshot']]) {
    t.alike(agentArgs(argv), argv, argv[0])
  }
})

test('agentDesktopTooOld rejects everything below the floor', (t) => {
  for (const v of ['0.1.14', '0.2.0', '0.2.3', '0.3.0', '0.4.4', '0.7.9']) t.is(agentDesktopTooOld(v), true, v)
})

test('agentDesktopTooOld accepts 0.8.0 and newer', (t) => {
  for (const v of ['0.8.0', '0.8.1', '0.9.0', '1.0.0']) t.is(agentDesktopTooOld(v), false, v)
})

test('agentDesktopTooOld treats unparseable versions as too old', (t) => {
  for (const v of ['', 'latest', undefined, null]) t.is(agentDesktopTooOld(v), true, String(v))
})

test('the declared floor passes its own gate', (t) => {
  t.is(agentDesktopTooOld(MIN_AGENT_DESKTOP), false)
})

// 0.8.x keeps statictext in the interactive lens AND gives it a ref, so a
// `<label for>` surfaces as a ref'd statictext carrying the same accessible name as
// the control it labels — and wins any name-only match on document order. These pin
// the `actionable` lens that keeps ref resolution off the label.
const labelledField = {
  role: 'window',
  children: [
    { role: 'statictext', name: 'Space name', ref_id: 'e1', value: 'Space name' },
    { role: 'textfield', name: 'Space name', ref_id: 'e2', value: '' },
  ],
}

test('actionable ref resolution skips a statictext sharing the control name', (t) => {
  const hit = findNode(labelledField, { name: 'Space name', actionable: true })
  t.is(hit.role, 'textfield')
  t.is(hit.ref, 'e2', 'the field, not the label that precedes it')
})

test('assertions still see statictext — the asymmetry is deliberate', (t) => {
  const hit = findNode(labelledField, { name: 'Space name' })
  t.is(hit.role, 'statictext', 'visible text lives here, so reads must not skip it')
})

test('actionable does not change matching when no statictext competes', (t) => {
  const tree = { role: 'window', children: [{ role: 'button', name: 'Create', ref_id: 'e7' }] }
  t.is(findNode(tree, { name: 'Create', actionable: true }).ref, 'e7')
})

// The false PASS isDisabled() used to return: a statictext never carries `disabled`,
// so resolving to the label reported an actually-disabled control as enabled.
test('actionable resolves to the control that carries the disabled state', (t) => {
  const tree = {
    role: 'window',
    children: [
      { role: 'statictext', name: 'Create', ref_id: 'e3', value: 'Create' },
      { role: 'button', name: 'Create', ref_id: 'e4', states: ['disabled'] },
    ],
  }
  t.ok(findNode(tree, { name: 'Create', actionable: true }).states.includes('disabled'))
  t.absent(findNode(tree, { name: 'Create' }).states.includes('disabled'), 'the label looks enabled')
})
