import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The download folder and the transfer caps are the worker's own, written to settings.json the
// moment they change: a worker that is replaced, and an app that is relaunched, both come back
// showing what the user chose. Nothing of either rides the bootstrap frame any more, so a restart
// cannot revert a setting main never heard about.
function workerPid(store) {
  const out = execFileSync('lsof', ['-t', path.join(store, 'run', 'daemon.lock')], { encoding: 'utf8' }).trim()
  return Number(out.split('\n')[0])
}

export default async function s172({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  // The harness's download-folder lever would shadow the stored folder for the whole run.
  const A = new Instance({ name: 'Settings', bootstrap, slot: 0, total: 1, env: { MIRALL_DOWNLOAD_FOLDER: '' } })
  const chosen = workDir('dl-chosen-')
  let first = 0

  const expectStored = async (label) => {
    await A.gotoSettings('Storage')
    await A.waitText('Download folder', 20000)
    await waitFor(async () => A.hasText(chosen), 20000, `${label}: the chosen folder is shown`)
    await A.click({ name: 'Back' })
    await A.waitText('Manage your experience', 8000)
    await A.click({ name: 'Network' })
    await A.waitText('Transfer Limits', 8000)
    await waitFor(async () => (await A.nodeValue({ name: 'Download limit: 5 MB/s' })) === '1', 20000, `${label}: 5 MB/s still pressed`)
  }

  try {
    await r.ok('a download folder and a cap are chosen', async () => {
      await A.launch()
      await A.gotoSettings('Storage')
      await A.waitText('Download folder', 20000)
      await A.nativeChoosePath(chosen, { trigger: () => A.click({ role: 'button', name: 'Change' }) })
      await waitFor(async () => A.hasText(chosen), 20000, 'the chosen folder is shown')
      await A.click({ name: 'Back' })
      await A.waitText('Manage your experience', 8000)
      await A.click({ name: 'Network' })
      await A.waitText('Transfer Limits', 8000)
      await A.click({ name: 'Download limit: 5 MB/s' })
      await waitFor(async () => (await A.nodeValue({ name: 'Download limit: 5 MB/s' })) === '1', 8000, '5 MB/s pressed')
      await A.shot('s172-chosen', runDir)
      first = workerPid(A.store)
      assert(first > 0, 'the worker holds the profile lock')
    })

    await r.ok('a replaced worker comes back with both settings', async () => {
      process.kill(first, 'SIGKILL')
      await waitFor(async () => {
        try { return workerPid(A.store) !== first } catch { return false }
      }, 30000, 'a new worker to take the lock')
      await A.click({ name: 'Back' })
      await A.waitText('Manage your experience', 8000)
      await expectStored('after the worker restart')
      await A.shot('s172-after-respawn', runDir)
    })

    await r.ok('a relaunched app shows both settings', async () => {
      await A.relaunch()
      await expectStored('after the relaunch')
      await A.shot('s172-after-relaunch', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A] }
}
