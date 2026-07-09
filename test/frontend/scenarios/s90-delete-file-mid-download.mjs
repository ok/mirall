import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// C3 — the owner DELETES a single file from the source folder on disk while a peer is
// downloading it. The real chokidar watcher (Electron main) publishes a tombstone; the
// peer's row for that file clears and no full file lands, while a sibling file is
// untouched. 256 MB keeps the peer mid-flight. (s27 is the at-rest twin.)
export default async function s90 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Docs')
  mkdirSync(ownDir, { recursive: true })
  const target = path.join(ownDir, 'big.bin')
  writeFileSync(target, Buffer.alloc(256 * 1024 * 1024, 17))
  writeFileSync(path.join(ownDir, 'keep.txt'), 'i survive')
  const landed = path.join(B.downloadFolder, 'big.bin')

  try {
    await r.ok('A shares "Docs"; B opens it and starts downloading big.bin', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Docs', 60000)
      await B.openFolder('Docs')
      await B.waitText('big.bin', 20000)
      await B.click({ role: 'button', name: 'Download' })

      let mid = false
      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await B.has({ role: 'button', name: 'Cancel' })) { mid = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }
      console.log(`s90: caught B mid-download: ${mid}`)
    })

    await r.ok('A deletes big.bin from disk mid-download → B row clears, keep.txt stays', async () => {
      unlinkSync(target) // the real owned-folder chokidar watcher tombstones it
      await waitFor(async () => !(await B.hasText('big.bin')), 60000, 'big.bin row clears on the peer after source delete')
      assert(!existsSync(landed), 'no full file lands after the source file is deleted mid-download')
      assert(await B.hasText('keep.txt'), 'the sibling file keep.txt is unaffected')
      await B.shot('s90-B-file-removed', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
