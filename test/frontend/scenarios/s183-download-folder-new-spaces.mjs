import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Settings → Storage keeps one download folder, "Download Folder for New Spaces": a space starts
// downloading there when it is created, then keeps its own folder. Changing the setting moves no
// existing space.
export default async function s183({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  // The harness's download-folder lever would shadow the stored folder for the whole run.
  const A = new Instance({ name: 'Settings', bootstrap, slot: 0, total: 1, env: { MIRALL_DOWNLOAD_FOLDER: '' } })
  const first = workDir('first-')
  const second = workDir('second-')
  mkdirSync(first, { recursive: true })
  mkdirSync(second, { recursive: true })

  const chooseNewSpaceFolder = async (dir) => {
    await A.gotoSettings('Storage')
    await A.waitText('Download Folder for New Spaces', 20000)
    await A.nativeChoosePath(dir, { trigger: () => A.click({ role: 'button', name: 'Change' }) })
    await waitFor(() => A.hasText(dir), 20000, 'Storage shows the chosen folder')
  }
  const closeEditSpace = async () => {
    await A.press('Escape')
    await waitFor(async () => !(await A.hasText('Downloads go to')), 10000, 'Edit Space closed')
  }
  const spaceFolderShows = async (spaceName, dir) => {
    await A.click({ name: `Open ${spaceName}` })
    await A.openEditSpace()
    await A.waitText('Downloads go to', 10000)
    const shows = await A.hasText(dir)
    await closeEditSpace()
    await A.back()
    await A.waitText('Create Space', 20000)
    return shows
  }

  try {
    await r.ok('Storage names the setting for what it does', async () => {
      await A.launch()
      await A.gotoSettings('Storage')
      await A.waitText('Download Folder for New Spaces', 20000)
      assert(await A.hasText('changing this one does not change them'), 'it says existing spaces keep their folders')
      await A.shot('s183-storage', runDir)
      await A.click({ name: 'Back' })
    })

    await r.ok('a space created after choosing a folder starts there', async () => {
      await chooseNewSpaceFolder(first)
      await A.click({ name: 'Home' })
      await A.createSpaceOnly('Aurora')
      await A.openEditSpace()
      await A.waitText('Downloads go to', 10000)
      assert(await A.hasText(first), 'Aurora starts in the chosen folder')
      await closeEditSpace()
      await A.back()
      await A.waitText('Create Space', 20000)
    })

    await r.ok('changing the setting seeds the next space and moves no existing one', async () => {
      await chooseNewSpaceFolder(second)
      await A.click({ name: 'Home' })
      await A.createSpaceOnly('Borealis')
      await A.openEditSpace()
      await A.waitText('Downloads go to', 10000)
      assert(await A.hasText(second), 'Borealis starts in the new folder')
      await closeEditSpace()
      await A.back()
      await A.waitText('Create Space', 20000)
      assert(await spaceFolderShows('Aurora', first), 'Aurora kept its folder')
      await A.shot('s183-kept', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
