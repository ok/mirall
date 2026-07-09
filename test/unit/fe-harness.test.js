import test from 'brittle'
import { agentArgs } from '../frontend/agent.mjs'
import { agentDesktopTooOld, MIN_AGENT_DESKTOP } from '../frontend/preflight.mjs'

// The frontend AX suite itself is local-only (CI can't drive the AX tree), but
// these two pure helpers gate the upgrade to agent-desktop 0.3.0+ and can run in
// CI. They encode the two breaking changes the bump required: global-flag
// hoisting (--session/--headed precede the subcommand) and the version floor.

test('agentArgs hoists --session ahead of the subcommand', (t) => {
  t.alike(
    agentArgs(['snapshot', '--window-id', 'w-1', '--max-depth', '40'], { session: 'mirall-owner' }),
    ['--session', 'mirall-owner', 'snapshot', '--window-id', 'w-1', '--max-depth', '40'],
  )
})

test('agentArgs adds --headed for cursor commands (session then headed then args)', (t) => {
  t.alike(
    agentArgs(['hover', '@e1'], { session: 'mirall-peer', headed: true }),
    ['--session', 'mirall-peer', '--headed', 'hover', '@e1'],
  )
})

test('agentArgs is a no-op when no globals are requested', (t) => {
  t.alike(agentArgs(['list-windows']), ['list-windows'])
  t.alike(agentArgs(['press', 'return'], {}), ['press', 'return'])
})

test('agentArgs supports --headed without a session', (t) => {
  t.alike(agentArgs(['mouse-move', '--xy', '5,5'], { headed: true }), ['--headed', 'mouse-move', '--xy', '5,5'])
})

test('agentDesktopTooOld rejects the pre-0.3 line', (t) => {
  for (const v of ['0.1.14', '0.2.0', '0.2.3']) t.is(agentDesktopTooOld(v), true, v)
})

test('agentDesktopTooOld accepts 0.3.0 and newer', (t) => {
  for (const v of ['0.3.0', '0.3.1', '0.4.4', '1.0.0']) t.is(agentDesktopTooOld(v), false, v)
})

test('agentDesktopTooOld treats unparseable versions as too old', (t) => {
  for (const v of ['', 'latest', undefined, null]) t.is(agentDesktopTooOld(v), true, String(v))
})

test('the declared floor passes its own gate', (t) => {
  t.is(agentDesktopTooOld(MIN_AGENT_DESKTOP), false)
})
