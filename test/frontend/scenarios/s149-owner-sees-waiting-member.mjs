import { closeSync, mkdirSync, openSync, truncateSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText, flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// While the owner is still hashing a file, a member whose mirror is waiting on it shows on the
// owner's row: the hashing bar stays, and beside it an avatar stack naming the member plus a
// "1 waiting" toggle. Expanded, the dropdown lists the member as "Waiting for indexing" — never the
// offline-downloader "Waiting" — with no progress bar,
// and the row never reads as sending. When the member pauses its mirror, the waiter leaves the
// owner's row at once while the hash is still running.
//
// The file is sparse: it costs no disk, but the owner hashes every byte of it, so the indexing
// window outlasts every UI step below (a hash that finished first would leave nothing to assert).
// Pausing the mirror before the hash lands keeps the member from then downloading all of it.
const BIG = 32 * 1024 * 1024 * 1024

// The raw subtree under the first node matching `pred`, so a region's own text can be read apart
// from the rest of the window.
function subtree(node, pred) {
  if (!node || typeof node !== 'object') return null
  if (node.role && pred(node)) return node
  for (const k of node.children ?? []) {
    const hit = subtree(k, pred)
    if (hit) return hit
  }
  return null
}

export default async function s149({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')

  const WAITING = { role: 'button', name: '1 waiting' }
  const LIST = 'People waiting for this file'

  try {
    await r.ok('A shares "Reports"; B mirrors it; A opens the folder', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Reports', 60000)
      await B.mirrorShare(mirrorDir)
      await A.waitText('Reports', 60000)
      await A.openFolder('Reports')
      await A.waitText('q1', 30000)
    })

    await r.ok('A adds a big file; its row keeps the indexing bar and shows "1 waiting" — never Sending', async () => {
      const big = path.join(ownDir, 'archive.bin')
      closeSync(openSync(big, 'w'))
      truncateSync(big, BIG)
      let text = ''
      await waitFor(async () => {
        try { text = allText(await A.snap()) } catch { return false }
        return text.includes('1 waiting') && text.includes('Indexing progress')
      }, 90000, 'owner row shows the waiter beside its own indexing bar')
      await A.shot('s149-A-waiting', runDir)
      assert(text.includes('Indexing progress'), 'the owner is still hashing: the indexing bar is on the same snapshot')
      assert(!/\bSending\b/.test(text), 'a waiter never makes the row read as sending')
      assert(!/\d+ downloading/.test(text), 'nor counts as a download')
      assert(await A.has(WAITING), 'the "1 waiting" toggle is a button named by its visible text')
      assert(await A.has({ name: 'Waiting for this file: Bob' }), 'the avatar stack names the waiting member')
    })

    await r.ok('expanded, the dropdown lists Bob as Waiting for indexing with no progress bar', async () => {
      await A.click(WAITING)
      await waitFor(() => A.has({ name: LIST }), 10000, 'waiters dropdown')
      const tree = await A.snap()
      const toggle = flatten(tree).find((n) => n.role === 'button' && (n.name === '1 waiting' || n.description === '1 waiting'))
      assert(toggle && toggle.states.includes('expanded'), 'the toggle reports its expanded state')
      const region = subtree(tree, (n) => n.name === LIST || n.description === LIST)
      assert(region, 'the dropdown region is named for the people waiting')
      const regionText = allText(region)
      assert(regionText.includes('Bob'), 'Bob is named in the list')
      assert(regionText.includes('Waiting for indexing'), 'his row reads Waiting for indexing')
      assert(!flatten(region).some((n) => n.role === 'progressbar'), 'a waiting row has no progress bar')
      assert(!(await A.has({ role: 'progressbar', name: "Bob's download" })), 'nor anywhere on the row')
      await A.shot('s149-A-waiters-list', runDir)
    })

    await r.ok('B pauses its mirror; the waiter leaves A\'s row while A is still hashing', async () => {
      await B.pauseMirror()
      let text = ''
      await waitFor(async () => {
        try { text = allText(await A.snap()) } catch { return false }
        return !text.includes('1 waiting')
      }, 20000, 'the waiter clears on the member\'s stop, not after the idle window')
      assert(text.includes('Indexing progress'), 'the owner was still hashing when the waiter cleared')
      await A.shot('s149-A-cleared', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
