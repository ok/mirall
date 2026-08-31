import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// A user browsing a folder keeps their rows when the owner drops offline.
//
// What this does and does NOT prove, measured rather than assumed. An offline owner fails the head
// sync, so share:list-files reports complete:false — but the entries still come from the catalog
// blocks already replicated locally, so the read is incomplete-and-PARTIAL, not empty. That is the
// common real-world shape and it is worth holding, but it does not discriminate the never-blank
// fold: adopting such a response wholesale yields the same rows. Verified by breaking the fold to
// adopt wholesale and re-running this scenario, which still passed.
//
// The incomplete-and-EMPTY case — where wholesale adoption would blank the folder — needs a peer
// catalog that cannot be opened or has no local blocks, which the UI cannot stage deterministically.
// test/unit/share-files-fold.test.js is the gate for that one, and 4 of its 9 tests do fail against
// a wholesale-adopt fold.
export default async function s118 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('blank-own-'), 'Reports')
  mkdirSync(ownDir, { recursive: true })
  for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
    writeFileSync(path.join(ownDir, name), name.repeat(64))
  }

  try {
    await r.ok('A shares a folder; B opens it and sees every file', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Reports', 90000)
      await B.click({ role: 'button', contains: 'Reports' })
      await B.waitText('alpha.txt', 60000)
      await B.waitText('beta.txt', 30000)
      await B.waitText('gamma.txt', 30000)
      await B.shot('s118-B-folder-populated', runDir)
    })

    await r.ok('the owner drops while B is IN the folder — the rows stay on screen', async () => {
      await A.quit()
      // Let B's listing re-read several times against an owner that is gone. Each read comes back
      // incomplete; every one of them must leave the rows alone.
      await new Promise((resolve) => setTimeout(resolve, 20000))

      for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
        if (!(await B.has({ contains: name }))) {
          throw new Error(`${name} vanished from the folder while the owner was offline`)
        }
      }
      await B.shot('s118-B-owner-offline-rows-kept', runDir)
    })

    await r.ok('the header still agrees with the rows', async () => {
      // deriveFolderInfo may only ever raise the count above the visible rows on an incomplete
      // read; a header reading fewer files than are listed is always wrong.
      if (await B.has({ contains: '0 files' })) {
        throw new Error('the folder header collapsed to zero while rows were still on screen')
      }
    })

    await r.ok('the owner returns and the listing is still correct', async () => {
      await A.launch({ onboard: false })
      await B.waitText('alpha.txt', 90000)
      await B.shot('s118-B-owner-returned', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
