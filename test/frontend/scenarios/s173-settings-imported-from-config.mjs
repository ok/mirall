import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// An install upgraded from a build where main kept the download folder and the caps in
// config.json: the worker's first boot imports them into its own settings.json, and main drops
// the moved groups from config.json on its next load — each process touching only its own file.
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))

export default async function s173({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Upgrade', bootstrap, slot: 0, total: 1, env: { MIRALL_DOWNLOAD_FOLDER: '' } })
  const seeded = workDir('dl-seeded-')
  const configPath = () => join(A.store, 'config.json')
  const settingsPath = () => join(A.store, 'settings.json')

  try {
    await r.ok('an older config.json holds the folder and the caps, and no settings.json exists', async () => {
      await A.launch()
      await A.quit()
      rmSync(settingsPath(), { force: true })
      const config = read(configPath())
      config.downloads = { folder: seeded }
      config.network = { downloadKBps: 5120, uploadKBps: 0, relayMode: 'off', relay: null, downloadConcurrency: 6 }
      writeFileSync(configPath(), JSON.stringify(config))
    })

    await r.ok('the next launch shows the imported folder and cap', async () => {
      await A.relaunch()
      await A.gotoSettings('Storage')
      await A.waitText('Download folder', 20000)
      await waitFor(async () => A.hasText(seeded), 20000, 'the imported folder is shown')
      await A.click({ name: 'Back' })
      await A.waitText('Manage your experience', 8000)
      await A.click({ name: 'Network' })
      await A.waitText('Transfer Limits', 8000)
      await waitFor(async () => (await A.nodeValue({ name: 'Download limit: 5 MB/s' })) === '1', 20000, 'the imported cap is pressed')
      await A.shot('s173-imported', runDir)
    })

    await r.ok('settings.json now holds them, and config.json keeps them until main reloads', async () => {
      await A.quit()
      const own = read(settingsPath())
      assert(own.downloads.folder === seeded, 'settings.json holds the folder')
      assert(own.network.downloadKBps === 5120, 'settings.json holds the cap')
      const config = read(configPath())
      assert(config.downloads?.folder === seeded, 'config.json still carries the group main has not dropped yet')
    })

    await r.ok('the launch after that drops the moved groups from config.json and keeps the rest', async () => {
      await A.relaunch()
      await A.quit()
      const config = read(configPath())
      assert(!('downloads' in config), 'downloads dropped')
      assert(!('network' in config), 'network dropped')
      assert(!('backup' in config), 'backup dropped')
      assert(config.appearance && config.general, 'the host\'s groups are untouched')
      assert(read(settingsPath()).downloads.folder === seeded, 'and the worker\'s copy is untouched')
    })
  } catch {}

  return { pass: r.summary(), instances: [A] }
}
