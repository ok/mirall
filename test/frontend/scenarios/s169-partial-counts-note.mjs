import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'
import { flatten } from '../tree.mjs'

// Folder counts and the storage total say when they may be too low. While B cannot read A's
// folder catalog in full, the space's storage card, the Mirror to Disk dialog and its preview each
// show one sentence saying so, instead of presenting a partial count as the folder's size.
//
// B is relaunched with MIRALL_TEST_TRUNCATE_PEER_DRAIN_AFTER=1 (see s168): every drain of a peer
// catalog stops after its first entry and reports itself unfinished, so each read of A's
// three-file folder stalls while A stays online.
//
// Pairs with a VoiceOver spot-check: the dialog notes are Callouts with an aria-hidden icon; the
// storage card's is a plain sentence under the totals.
const STORAGE_NOTE = "Some file lists can't be read yet, so these numbers may be too low."
const FOLDER_NOTE = "This folder's file list can't be read in full yet, so these numbers may be too low."

export default async function s169({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('partial-counts-'), 'Media')
  mkdirSync(ownDir, { recursive: true })
  for (const name of ['one.txt', 'two.txt', 'three.txt']) writeFileSync(path.join(ownDir, name), name)
  const mirrorDir = workDir('partial-mirror-')
  mkdirSync(mirrorDir, { recursive: true })

  // The sentence is one accessibility-tree text node carrying all of it.
  const assertOneNode = async (note, where) => {
    const nodes = flatten(await B.snap()).filter((n) => `${n.name} ${n.value}`.includes(note))
    assert(nodes.length === 1, `${where}: the note is one accessible text node (found ${nodes.length})`)
  }

  try {
    await r.ok('A shares a folder and B sees it, with no note on a whole read', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Media', 60000)
      assert(!(await B.hasText(STORAGE_NOTE)), 'a whole storage total carries no note')
    })

    await r.ok('with B unable to finish reading A, the storage card says its total may be too low', async () => {
      B.env.MIRALL_TEST_TRUNCATE_PEER_DRAIN_AFTER = '1'
      await B.relaunch()
      await B.waitText('Aurora', 60000)
      await B.click({ name: 'Open Aurora' })
      await B.waitText('Media', 60000)
      await B.waitText(STORAGE_NOTE, 60000)
      await assertOneNode(STORAGE_NOTE, 'storage card')
      await B.shot('s169-B-storage', runDir)
    })

    await r.ok('the Mirror to Disk dialog says the folder counts may be too low', async () => {
      await B.click({ name: 'More', last: true })
      await new Promise((res) => setTimeout(res, 400))
      await B.click({ name: 'Mirror to Disk…' })
      await B.waitText('to Disk', 20000)
      await B.waitText(FOLDER_NOTE, 30000)
      await assertOneNode(FOLDER_NOTE, 'mirror dialog')
      await B.shot('s169-B-mirror-dialog', runDir)
    })

    await r.ok('the mount preview says it covers part of the folder', async () => {
      await B.nativeChoosePath(mirrorDir, { trigger: () => B.click({ role: 'button', name: 'Browse…' }) })
      await B._previewReady()
      await B.click({ role: 'button', name: 'Next: Preview' })
      await B.waitText('Download', 20000)
      await B.waitText(FOLDER_NOTE, 20000)
      await assertOneNode(FOLDER_NOTE, 'mount preview')
      await B.shot('s169-B-preview', runDir)
    })
  } catch {} finally {
    delete B.env.MIRALL_TEST_TRUNCATE_PEER_DRAIN_AFTER
  }
  return { pass: r.summary(), instances: [A, B] }
}
