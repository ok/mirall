import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'

// A worker that dies under a window is replaced, and the window reconnects to the new one over its
// own socket connection: the space it was showing comes back without a reload. The worker is found
// as the process holding the profile's daemon lock, and killed outright, so the socket it leaves
// behind is the stale one the next worker has to replace.
function workerPid(store) {
  const out = execFileSync('lsof', ['-t', path.join(store, 'run', 'daemon.lock')], { encoding: 'utf8' }).trim()
  return Number(out.split('\n')[0])
}

export default async function s170({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Respawn', bootstrap, slot: 0, total: 1 })
  let first = 0

  try {
    await r.ok('a space is open over the first worker', async () => {
      await A.launch()
      await A.createSpaceOnly('Survivor')
      await A.back()
      await A.waitText('Open Survivor', 20000)
      first = workerPid(A.store)
      assert(first > 0, 'the worker holds the profile lock')
    })

    await r.ok('the worker is killed and a new one takes its place', async () => {
      process.kill(first, 'SIGKILL')
      await waitFor(async () => {
        try { return workerPid(A.store) !== first } catch { return false }
      }, 30000, 'a new worker to take the lock')
    })

    await r.ok('the window talks to the new worker without a reload', async () => {
      await A.click({ name: 'Open Survivor' })
      await A.waitText('Members', 30000)
      await A.shot('s170-after-respawn', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A] }
}
