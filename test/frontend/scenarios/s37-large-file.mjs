import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

function patterned (n, seed = 7) {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * seed + 13) & 0xff
  return b
}

// P2 / G12 — a large multi-block file must materialize byte-exact on the mirror
// (no truncation/corruption). s6 only checks the mirror's total size crossed a
// threshold; this asserts the full content. The strict "no premature partial
// publish" timing is a chokidar-config property and isn't asserted in the racy
// UI window.
export default async function s37 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Bulk')
  const mirrorDir = workDir('mirror-')
  const bytes = patterned(12 * 1024 * 1024, 17)        // 12 MiB
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'big.bin'), bytes)

  try {
    await r.ok('launch + connect + A shares a 12 MiB file', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Bulk', 60000)
    })
    await r.ok('B mirrors it; the file lands byte-exact', async () => {
      await B.mirrorShare(mirrorDir)
      const dst = path.join(mirrorDir, 'big.bin')
      await waitFor(() => existsSync(dst) && statSync(dst).size === bytes.length, 120000, 'full-size big.bin on mirror')
      assert(readFileSync(dst).equals(bytes), 'mirrored bytes match the source exactly')
      await B.shot('s37-B-large-file', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
