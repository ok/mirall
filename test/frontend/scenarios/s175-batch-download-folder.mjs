import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Download N from a browse folder: the column closes, the band shows one strip for the batch with
// a named progressbar, rows behind a one-slot gate read Waiting, same-named files land in their own
// folders under the folder's name, Cancel All clears the strip and every partial, and a second
// batch completes to On your device. Bob's worker reads its gate and its download cap from the
// settings file written beside its store before it boots.
const SIZE = 48 * 1024 * 1024

export default async function s175({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })
  mkdirSync(B.store, { recursive: true })
  writeFileSync(path.join(B.store, 'settings.json'), JSON.stringify({ network: { downloadConcurrency: 1, downloadKBps: 6144 } }))

  const ownDir = path.join(workDir('own-'), 'Vault')
  mkdirSync(path.join(ownDir, 'big'), { recursive: true })
  mkdirSync(path.join(ownDir, 'small'), { recursive: true })
  writeFileSync(path.join(ownDir, 'big', 'one.bin'), Buffer.alloc(SIZE, 1))
  writeFileSync(path.join(ownDir, 'big', 'two.bin'), Buffer.alloc(SIZE, 2))
  writeFileSync(path.join(ownDir, 'small', 'a.txt'), 'the one in small')
  writeFileSync(path.join(ownDir, 'a.txt'), 'the one at the root')
  const landed = (...rel) => path.join(B.downloadFolder, 'Vault', ...rel)
  const partials = () => readdirSync(B.downloadFolder, { recursive: true }).map(String).filter((f) => f.endsWith('.mirall.part'))

  try {
    await r.ok('B opens the folder and starts the whole folder as one batch', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Vault', 60000)
      await B.openFolder('Vault')
      await waitFor(() => B.has({ role: 'checkbox', name: 'Select all 4 files' }), 60000, 'all four files listed')
      await B.click({ role: 'checkbox', name: 'Select all 4 files' })
      await B.waitText('4 selected', 20000)
      await B.click({ role: 'button', name: 'Download 4' })
      await waitFor(async () => !(await B.has({ role: 'checkbox', name: 'Select a.txt' })), 20000, 'the column closed')
    })

    await r.ok('the batch strip appears with a named progressbar and a row reads Waiting', async () => {
      await B.waitText('Downloading 4 files', 20000)
      await waitFor(() => B.has({ role: 'progressbar', name: 'Batch download progress' }), 20000, 'the batch progressbar')
      await B.waitText('Waiting', 30000)
      await B.shot('s175-waiting', runDir)
    })

    await r.ok('Cancel All, while the large files are still moving, removes the strip and every partial', async () => {
      await B.click({ role: 'button', name: 'Cancel All' })
      await waitFor(async () => !(await B.hasText('Downloading 4 files')), 20000, 'the strip is gone')
      await waitFor(() => partials().length === 0, 30000, 'no partial remains')
      await B.waitText('Available', 20000)
      assert(!existsSync(landed('big', 'one.bin')) || !existsSync(landed('big', 'two.bin')), 'the batch stopped before both large files landed')
      await B.shot('s175-cancelled', runDir)
    })

    await r.ok('a second batch lands same-named files in their own folders and clears its strip', async () => {
      await B.click({ role: 'checkbox', name: 'Select all 4 files' })
      await B.waitText('selected', 20000)
      await waitFor(async () => (await B.has({ role: 'button', name: 'Download 4' })) || (await B.has({ role: 'button', name: 'Download 3' })), 20000, 'the download verb is offered')
      const verb = (await B.has({ role: 'button', name: 'Download 4' })) ? 'Download 4' : 'Download 3'
      await B.click({ role: 'button', name: verb })
      await waitFor(() => ['big/one.bin', 'big/two.bin', 'small/a.txt', 'a.txt'].every((rel) => existsSync(landed(...rel.split('/')))), 180000, 'every file landed')
      assert(readFileSync(landed('small', 'a.txt'), 'utf8') === 'the one in small', 'the nested copy is the nested file')
      assert(readFileSync(landed('a.txt'), 'utf8') === 'the one at the root', 'the root copy is the root file')
      await waitFor(async () => !(await B.hasText('Downloading')), 60000, 'the strip cleared itself')
      assert(!(await B.hasText('Waiting')), 'nothing waits any more')
      await B.shot('s175-done', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
