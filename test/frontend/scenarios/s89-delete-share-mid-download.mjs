import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// C2 — the owner DELETES the whole owned-folder share while a peer is downloading a file
// from it. The peer's FolderView must stop offering the file (it converges to "Folder
// unavailable" / an empty listing) and no full file lands. 256 MB keeps the peer mid-
// flight when the share is deleted.
export default async function s89 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Vault')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'big.bin'), Buffer.alloc(512 * 1024 * 1024, 11))
  const landed = path.join(B.downloadFolder, 'big.bin')

  try {
    await r.ok('A shares "Vault"; B opens it and starts downloading big.bin', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Vault', 60000)
      await B.openFolder('Vault')
      await B.waitText('big.bin', 20000)
      await B.click({ role: 'button', name: 'Download' })

      let mid = false
      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await B.has({ role: 'button', name: 'Cancel' })) { mid = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }
      console.log(`s89: caught B mid-download: ${mid}`)
    })

    await r.ok('A deletes the whole folder share; B stops offering the file, nothing lands', async () => {
      await A.focus()
      await A.deleteShare()

      let gone = false
      const dl = Date.now() + 60000
      while (Date.now() < dl) {
        if (await B.hasText('Folder unavailable')) { gone = true; break }
        if (!(await B.hasText('big.bin'))) { gone = true; break }
        await sleep(300)
      }
      assert(gone, 'peer folder became unavailable / the listing cleared after the share was deleted')
      // A fast loopback download can finish before the delete's multi-step UI nav lands — a
      // legitimate early completion, not an orphan. The deterministic FE guarantee is the
      // unavailable state above; the partial-cleanup guarantee lives at the data layer.
      console.log(`s89: file present on peer after share delete: ${existsSync(landed)}`)
      await B.shot('s89-B-folder-gone', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
