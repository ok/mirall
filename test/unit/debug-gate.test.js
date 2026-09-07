import test from 'brittle'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// Module-level state, so each test starts from a known gate rather than from whatever the previous
// one left behind.
function freshGate(t, env = {}) {
  const resolved = require.resolve('../../src/main/debug-gate.js')
  delete require.cache[resolved]
  const gate = require(resolved)
  t.teardown(() => { delete require.cache[resolved] })
  return { gate, env }
}

test('the gate reads false before it is initialised', (t) => {
  const { gate } = freshGate(t)
  t.absent(gate.isDebug(), 'nothing is forwarded until main says whether this is a dev run')
})

test('a dev run raises the gate; a packaged run does not', (t) => {
  const { gate } = freshGate(t)
  t.ok(gate.initDebugGate({ isDev: true, env: {} }), 'dev')
  t.ok(gate.isDebug())

  gate.initDebugGate({ isDev: false, env: {} })
  t.absent(gate.isDebug(), 'packaged')
})

test('MIRALL_DEBUG raises the gate on a packaged build', (t) => {
  const { gate } = freshGate(t)
  gate.initDebugGate({ isDev: false, env: { MIRALL_DEBUG: '1' } })
  t.ok(gate.isDebug())
})

test('verbose is seeded from the environment and is separate from debug', (t) => {
  const { gate } = freshGate(t)
  gate.initDebugGate({ isDev: false, env: { MIRALL_VERBOSE: '1' } })
  t.ok(gate.isVerbose(), 'the worker bootstrap seed is on')
  t.absent(gate.isDebug(), 'but main is not logging — they are different switches')
})

test('setVerbose(false) restores the build default rather than forcing the gate off', (t) => {
  // A debug build that the user toggled twice is still a debug build. Resetting to plain `false`
  // would silently downgrade it for the rest of the session.
  const { gate } = freshGate(t)
  gate.initDebugGate({ isDev: true, env: {} })

  t.ok(gate.setVerbose(true), 'on')
  t.ok(gate.setVerbose(false), 'off returns to the build default, which is on for a dev run')
  t.ok(gate.isDebug())
  t.absent(gate.isVerbose(), 'the worker seed did go off')
})

test('on a packaged build setVerbose does turn the gate back off', (t) => {
  const { gate } = freshGate(t)
  gate.initDebugGate({ isDev: false, env: {} })
  t.ok(gate.setVerbose(true))
  t.absent(gate.setVerbose(false))
  t.absent(gate.isDebug())
})

test('a non-boolean argument reports the state without changing it', (t) => {
  const { gate } = freshGate(t)
  gate.initDebugGate({ isDev: false, env: {} })
  gate.setVerbose(true)

  t.ok(gate.setVerbose(undefined), 'still on')
  t.ok(gate.setVerbose('off'), 'a string is not a switch')
  t.ok(gate.isVerbose(), 'and the worker seed was left alone too')
})
