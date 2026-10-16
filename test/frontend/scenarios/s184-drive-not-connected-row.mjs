import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// A downloaded copy says where it is when that is not the space's folder ("In …"), and a copy on a
// drive that is not connected reads "Drive not connected" with where it was saved — it is not
// deleted, so the claim stays — and offers Download to… for a fresh copy. The drive is a real
// volume (a RAM disk mounted under /Volumes) that is ejected, so the app tells it from a folder
// that was deleted on a disk that is still there: that copy is gone, and its row reads Available.
// A folder that is only recent, not the space's, never raises the not-connected toast.

const deviceIn = (out) => {
  const device = /\/dev\/disk\d+/.exec(out)?.[0]
  if (!device) throw new Error('no device in: ' + out)
  return device
}

// A formatted RAM disk of `mb` megabytes, mounted at /Volumes/<name>. Larger than the download
// preflight's free-space headroom (FREE_SPACE_HEADROOM, 64 MiB), or every download onto it is
// refused as disk full.
function attachDrive(name, mb = 128) {
  const image = `ram://${mb * 2048}`
  let device
  try {
    device = deviceIn(execFileSync('diskutil', ['image', 'attach', '--noMount', image], { encoding: 'utf8' }))
  } catch {
    device = deviceIn(execFileSync('hdiutil', ['attach', '-nomount', image], { encoding: 'utf8' }))
  }
  execFileSync('diskutil', ['erasevolume', 'HFS+', name, device], { stdio: 'ignore' })
  return { device, mountPath: path.join('/Volumes', name) }
}

function ejectDrive({ device }) {
  try {
    execFileSync('diskutil', ['eject', device], { stdio: 'ignore' })
  } catch {
    execFileSync('diskutil', ['unmountDisk', 'force', device], { stdio: 'ignore' })
    execFileSync('diskutil', ['eject', device], { stdio: 'ignore' })
  }
}

export default async function s184({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Handover')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'plan.pdf'), 'the plan')
  const elsewhere = path.join(workDir('elsewhere-'), 'Moved')
  mkdirSync(elsewhere, { recursive: true })
  const shown = (p) => (p.startsWith(homedir() + path.sep) ? '~' + p.slice(homedir().length) : p)
  const row = (status) => ({ name: `plan.pdf: ${status}` })
  // The listing reads the claims again when the folder is opened again; nothing tells the app a
  // drive or a folder went.
  const reopen = async () => {
    await B.back()
    await B.waitText('Folders Shared', 20000)
    await B.openFolder('Handover')
  }
  let drive = null
  let pressKit = null

  try {
    await r.ok('B downloads a file onto a drive, then moves the space back to its own folder', async () => {
      drive = attachDrive(`MirallS184-${process.pid}`)
      pressKit = path.join(drive.mountPath, 'Press kit')
      mkdirSync(pressKit, { recursive: true })
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Handover', 60000)
      await B.openFolder('Handover')
      await B.waitText('plan.pdf', 30000)
      await B.downloadRow({}, { path: pressKit })
      await waitFor(() => existsSync(path.join(pressKit, 'Handover', 'plan.pdf')), 60000, 'plan.pdf landed on the drive')
      await B.setDownloadsTo({ folder: path.basename(B.downloadFolder) })
      await waitFor(() => B.has({ name: `Downloads go to ${path.basename(B.downloadFolder)}, change` }), 20000, 'the space is back on its own folder')
    })

    await r.ok('the copy outside the space\'s folder says where it is', async () => {
      await waitFor(() => B.has(row('On your device')), 20000, 'still on the device')
      await B.waitText(`In ${shown(path.join(pressKit, 'Handover'))}`, 20000)
      await B.shot('s184-elsewhere', runDir)
    })

    await r.ok('with the drive ejected, the row reads Drive not connected and where it was saved', async () => {
      ejectDrive(drive)
      drive = null
      await reopen()
      await waitFor(() => B.has(row('Drive not connected')), 60000, 'the row reads Drive not connected')
      await B.waitText(`Saved to ${shown(path.join(pressKit, 'Handover'))}`, 20000)
      assert(await B.has({ role: 'combobox', name: 'Download to…' }), 'it offers Download to… for a fresh copy')
      assert(!(await B.hasText('which is not connected')), 'a recent folder that is not the space\'s raises no toast')
      await B.shot('s184-detached', runDir)
    })

    await r.ok('a fresh copy into another folder replaces the claim', async () => {
      await B.downloadRow({}, { path: elsewhere })
      await waitFor(() => existsSync(path.join(elsewhere, 'Handover', 'plan.pdf')), 60000, 'plan.pdf landed in the other folder')
      await B.setDownloadsTo({ folder: path.basename(B.downloadFolder) })
      await waitFor(() => B.has({ name: `Downloads go to ${path.basename(B.downloadFolder)}, change` }), 20000, 'the space is back on its own folder')
      await waitFor(() => B.has(row('On your device')), 30000, 'the row is on the device again')
      await B.waitText(`In ${shown(path.join(elsewhere, 'Handover'))}`, 20000)
      assert(!(await B.hasText('Saved to')), 'no stale place left on the row')
    })

    await r.ok('a copy whose folder was deleted on a disk that is still there reads Available', async () => {
      rmSync(elsewhere, { recursive: true, force: true })
      await reopen()
      await waitFor(() => B.has(row('Available')), 60000, 'the row reads Available')
      assert(!(await B.hasText('Drive not connected')), 'a deleted folder is not a drive that is away')
      assert(!(await B.hasText('Saved to')), 'and names no copy')
      assert(!(await B.hasText('which is not connected')), 'a deleted recent folder raises no toast either')
      await B.shot('s184-deleted', runDir)
    })

    await r.ok('a fresh copy into the space\'s folder is on the device', async () => {
      await B.downloadRow()
      await waitFor(() => existsSync(path.join(B.downloadFolder, 'Handover', 'plan.pdf')), 60000, 'plan.pdf landed in the space\'s folder')
      await waitFor(() => B.has(row('On your device')), 30000, 'the row is on the device again')
      assert(!existsSync(pressKit), 'the ejected drive was not recreated')
      assert(!existsSync(elsewhere), 'nor the deleted folder')
    })
  } catch {} finally {
    if (drive) {
      try { ejectDrive(drive) } catch (err) { console.error(`[s184] could not eject ${drive.device}: ${err.message}`) }
    }
  }
  return { pass: r.summary(), instances: [A, B] }
}
