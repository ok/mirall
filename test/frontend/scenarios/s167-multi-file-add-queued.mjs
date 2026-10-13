import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-LOOSE-QUEUED-ROWS: files added together were handed to the worker one at a
// time, so only the file being hashed was listed and the rest were invisible until their turn.)
// All of them are listed at once: the worker hashes a few at a time, the others read "Queued" with
// a line saying what they wait for, and each turns "Adding" when its hash starts. Big files keep
// the queued window open past the AX polls.
// REGRESSION (FIX-639: rows not yet listed by the worker led the list, so the file being hashed sat
// below the queued ones until the next listing.) Every frame lists our files in name order, the
// ones still on their way included, with an already-shared file sorting between the new ones.
export default async function s167({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const dir = workDir('multi-')
  const names = Array.from({ length: 6 }, (_, i) => `take-0${i}.bin`)
  const files = names.map((name, i) => {
    const abs = path.join(dir, name)
    writeFileSync(abs, Buffer.alloc(512 * 1024 * 1024, 21 + i))
    return abs
  })
  const earlier = 'take-03a.txt'
  writeFileSync(path.join(dir, earlier), 'shared before the batch')
  const listed = [...names, earlier].sort()
  const disorders = []
  const checkOrder = (text) => {
    const seen = listed.filter((n) => text.includes(n))
    const order = [...seen].sort((a, b) => text.indexOf(a) - text.indexOf(b))
    if (order.join() !== seen.join()) disorders.push(order.join(' '))
  }

  try {
    await r.ok('launch + create a space', async () => {
      await A.launch()
      await createSpaceWithInvite(A, { name: 'Aurora' })
      await A.waitText('Drop to Share', 30000)
    })

    await r.ok('a file shared before the batch', async () => {
      await A.addFile(path.join(dir, earlier))
      await waitFor(() => A.has({ name: `${earlier}: Shared by you` }), 30000, 'the earlier file is shared')
    })

    await r.ok('six files added together are all listed at once, the waiting ones as Queued', async () => {
      await A.addFiles(files)
      let text = ''
      await waitFor(async () => {
        try { text = allText(await A.snap()) } catch { return false }
        checkOrder(text)
        return names.every((n) => text.includes(n)) && /queued/i.test(text)
      }, 60000, 'every file listed while some still wait')
      await A.shot('s167-A-queued', runDir)
      assert(/adding/i.test(text), 'the files being hashed read Adding')
      assert(text.includes('Waits for the files ahead of it to finish adding.'), 'a queued row says what it waits for')
      assert(/take-0\d\.bin: Queued/.test(text), 'the queued pill is announced with its file name')
    })

    await r.ok('every file ends up shared', async () => {
      await waitFor(async () => {
        let text
        try { text = allText(await A.snap()) } catch { return false }
        checkOrder(text)
        return names.every((n) => text.includes(n)) && !/queued/i.test(text) && !/\badding\b/i.test(text)
      }, 180000, 'all six settle to Shared by you')
    })

    await r.ok('no frame lists the files out of name order', async () => {
      assert(disorders.length === 0, `rows out of name order: ${disorders[0]}`)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
