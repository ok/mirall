import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The Mirror to Disk modal's owner line — "{n} files · {size} · Owned by {owner}". It resolves a
// PEER's catalog, so it is the one summary in the app that costs a network round-trip, and the
// modal is unmounted on close. Reopening must paint the counts it already knows rather than
// starting again from the placeholder.
export default async function s129 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Media')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'one.txt'), 'first')
  writeFileSync(path.join(ownDir, 'two.txt'), 'second')
  writeFileSync(path.join(ownDir, 'three.txt'), 'third')

  const pause = (ms) => new Promise((res) => setTimeout(res, ms))

  // The share card's own ⋯ menu is the LAST "More"; the space header adds the first.
  const openMirrorModal = async () => {
    await B.click({ name: 'More', last: true })
    await pause(400)
    await B.click({ name: 'Mirror to Disk…' })
    await B.waitText('to Disk', 20000)
  }
  const closeMirrorModal = async () => {
    await B.click({ name: 'Close' })
    await pause(400)
  }

  try {
    await r.ok('launch + connect + A shares "Media"', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Media', 60000)
    })

    await r.ok('the mirror modal reports the real file count, not a fabricated zero', async () => {
      await openMirrorModal()
      await waitFor(async () => B.hasText('3 files'), 30000, 'the owner line carries the counted files')
      assert(!(await B.hasText('0 files')), 'no fabricated measurement is shown')
      await B.shot('s129-first-open', runDir)
    })

    // The cache: a reopen paints what the app already learned. Asserted with NO wait, so a modal
    // that started from its placeholder again would be caught in the act.
    await r.ok('reopening shows the counts on the first snapshot after open', async () => {
      await closeMirrorModal()
      await openMirrorModal()
      assert(await B.hasText('3 files'), 'the counts were there without a second wait')
      await B.shot('s129-reopen-cached', runDir)
      await closeMirrorModal()
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
