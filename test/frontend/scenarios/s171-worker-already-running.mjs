import { mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import FDLock from 'fd-lock'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { findNode } from '../tree.mjs'

// A profile another worker already serves cannot be opened a second time: the new worker exits as
// already running, and the window says so instead of retrying. The other worker is stood in for by
// this process holding the profile's daemon lock — two app instances cannot share a profile
// directory, Electron's own single-instance lock sees to that.
export default async function s171({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Second', bootstrap, slot: 0, total: 1 })
  const runPath = path.join(A.store, 'run')
  mkdirSync(runPath, { recursive: true, mode: 0o700 })
  const held = new FDLock(openSync(path.join(runPath, 'daemon.lock'), 'a+', 0o600))

  try {
    await r.ok('the window explains that Mirall is already running', async () => {
      await held.ready()
      await A.launch({ onboard: false })
      await A.waitText('Mirall is already running', 30000)
      assert(await A.hasText('Quit the other copy'), 'and what to do about it')
      const heading = findNode(await A.snap(), { name: 'Mirall is already running' })
      assert(heading?.role === 'heading', `the title is a heading (role ${heading?.role})`)
      await A.shot('s171-already-running', runDir)
    })

    await r.ok('and it does not retry behind the screen', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      assert(await A.hasText('Mirall is already running'), 'the screen stays')
      assert(!(await A.hasText("background service stopped")), 'it never turns into the retry-budget screen')
    })
  } catch {}

  try { await held.close() } catch {}
  return { pass: r.summary(), instances: [A] }
}
