import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// app.tsx and ipc.ts reach window/React and cannot be imported under Node, so this reads them as
// source — the same approach renderer-ipc-error-codes.test.js takes for the channel's error codes.
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const appSrc = readFileSync(path.join(root, 'src/renderer/app.tsx'), 'utf8')
const ipcSrc = readFileSync(path.join(root, 'src/renderer/ipc/ipc.ts'), 'utf8')

// REGRESSION (FIX-400-1: with no worker behind it, profile:get rejects; projectProfile treats a
// failed read as "no profile" and the shell opened ONBOARDING over an identity that exists. A user
// who completed it was one profile:set away from overwriting their real profile.)
test('REGRESSION (FIX-400-1): the shell gates on a channel fault before the profile gate', (t) => {
  const fault = appSrc.indexOf('if (fault) return')
  t.ok(fault !== -1, 'the fault gate exists')
  // `if (loading) return (` — the gate, not the bare `if (loading) return` guard inside the
  // changelog effect above it.
  t.ok(fault < appSrc.indexOf('if (loading) return ('), 'and sits above the boot gate')
  t.ok(fault < appSrc.indexOf('if (needsSetup) return'), 'and above onboarding')
})

test('the channel raises a fault on both terminal exits', (t) => {
  const give = ipcSrc.slice(ipcSrc.indexOf('const { respawn, delayMs, terminal }'))
  t.ok(/raiseChannelFault\(terminal === 'protocol' \? 'protocol' : 'budget'\)/.test(give),
    'a refused respawn raises the fault, whichever reason it had')
  t.ok(give.indexOf('raiseChannelFault') < give.indexOf('return'),
    'and raises it before the early return')
})

test('the fault is readable as a store, so the shell can gate on it before its first render', (t) => {
  t.ok(/export function getChannelFault\(\)/.test(ipcSrc))
  t.ok(/export function subscribeChannelFault\(/.test(ipcSrc))
  t.ok(/useSyncExternalStore\(subscribeChannelFault, getChannelFault/.test(
    readFileSync(path.join(root, 'src/renderer/hooks/useChannelFault.ts'), 'utf8')),
  'the hook subscribes rather than mirroring into component state')
})
