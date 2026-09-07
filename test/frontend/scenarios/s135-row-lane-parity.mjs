import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// Both file-row kinds — the loose space-root row and the folder-share row — now derive their
// right-hand lane from one view-model, so a rule that holds for one holds for the other. This
// asserts the three places where they used to disagree, on BOTH lists:
//
//   D2  a file being hashed shows an indexing bar before its first progress frame. The loose row
//       always did; the share row gated the bar on a frame having arrived and showed a bare pill.
//   D3  a just-requested download reports movement instead of sitting on the resting pill.
//   D1  the status badge carries the file's own name: "<filename>: Sending", not a bare "Sending".
//       The accessible name was added to the share row's badges only.
//
// 512 MB so the owner's hash and the transfer both outlast the AX poll window; the badge/indicator
// catches are still best-effort (loopback can finish inside the poll), so each is polled with a
// deadline and the deterministic state changes are what always gets asserted.
export default async function s135 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const SIZE = 512 * 1024 * 1024
  const dir = workDir('row-lane-')
  const ownDir = path.join(dir, 'Vault')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'seed.txt'), 'first')
  const loose = path.join(dir, 'reel.bin')
  const intoFolder = path.join(ownDir, 'payload.bin')

  const INDEXING = { role: 'progressbar', name: 'Indexing progress' }
  const looseLanded = path.join(B.downloadFolder, 'reel.bin')
  const shareLanded = path.join(B.downloadFolder, 'payload.bin')

  let sawLooseSending = false
  let sawShareSending = false

  try {
    await r.ok('launch + connect; A shares "Vault", B sees it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await A.waitText('Vault', 20000)
      await B.waitText('Vault', 60000)
    })

    await r.ok('a loose file being hashed shows an indexing bar before any frame', async () => {
      writeFileSync(loose, Buffer.alloc(SIZE, 7))
      await A.addFile(loose)
      // The bar exists to fill the gap BEFORE the first frame, so it must be up from the moment
      // the row appears — no decoration required.
      await waitFor(() => A.has(INDEXING), 20000, 'loose indexing bar')
      await A.shot('s135-A-loose-indexing', runDir)
    })

    await r.ok('a file dropped into the shared folder shows the same indexing bar', async () => {
      await A.openFolder('Vault')
      await A.waitText('seed', 20000)
      writeFileSync(intoFolder, Buffer.alloc(SIZE, 9))
      // Same act, same answer: before the fix this row fell through every progress branch to a
      // bare status pill until the worker's first frame landed.
      await waitFor(() => A.has(INDEXING), 60000, 'folder-share indexing bar')
      await A.shot('s135-A-share-indexing', runDir)
      await A.back()
    })

    await r.ok('B downloads the loose file; A’s badge names the file it describes', async () => {
      await B.focus()
      await B.waitText('reel', 90000)
      // Row-scoped, never hasText: that is a substring match over the WHOLE window, so a sibling
      // row's pill — or the "available" inside "Unavailable" — answers for this one. The badge's
      // own accessible name is the handle, which is the thing this change gives every row.
      await waitFor(() => B.has({ name: 'reel.bin: Available' }), 90000, 'loose row at rest')
      await B.click({ role: 'button', name: 'Download', last: true })
      // The deterministic half of D3: the row must leave the resting "Available" pill on the
      // click, not once bytes arrive.
      await waitFor(async () => !(await B.has({ name: 'reel.bin: Available' })), 20000, 'loose row leaves Available')
      await A.focus()
      const deadline = Date.now() + 25000
      while (Date.now() < deadline) {
        if (await A.has({ name: 'reel.bin: Sending' })) { sawLooseSending = true; break }
        if (existsSync(looseLanded)) break
        await sleep(200)
      }
      if (sawLooseSending) await A.shot('s135-A-loose-sending', runDir)
      await waitFor(() => existsSync(looseLanded), 180000, 'reel.bin landed on B')
    })

    await r.ok('B downloads the folder file; the same observable and the same named badge', async () => {
      await B.focus()
      await B.openFolder('Vault')
      await B.waitText('payload', 120000)
      await waitFor(() => B.has({ name: 'payload.bin: Available' }), 90000, 'folder row at rest')
      // The FIRST Download button is payload.bin's: buildFileTree sorts files alphabetically and
      // this folder holds only it and the marker file it was created with. The row-scoped wait
      // below is the check — a click that lands on the wrong row fails there rather than quietly
      // downloading the wrong file.
      await B.click({ role: 'button', name: 'Download' })
      await waitFor(async () => !(await B.has({ name: 'payload.bin: Available' })), 20000, 'folder row leaves Available')
      await A.focus()
      await A.openFolder('Vault')
      const deadline = Date.now() + 25000
      while (Date.now() < deadline) {
        if (await A.has({ name: 'payload.bin: Sending' })) { sawShareSending = true; break }
        if (existsSync(shareLanded)) break
        await sleep(200)
      }
      if (sawShareSending) await A.shot('s135-A-share-sending', runDir)
      await waitFor(() => existsSync(shareLanded), 180000, 'payload.bin landed on B')
    })

    console.log(`s135: named sending badge caught — loose: ${sawLooseSending}, share: ${sawShareSending}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
