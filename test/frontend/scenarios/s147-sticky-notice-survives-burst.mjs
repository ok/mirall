import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace, createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText, flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

const FILES = ['burst-1.bin', 'burst-2.bin', 'burst-3.bin', 'burst-4.bin', 'burst-5.bin']
const REMOVED = /Download stopped — “(burst-\d\.bin)” was removed by the owner/g
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// REGRESSION (FIX-373: the toast stack trimmed to four by position, so a burst of four newer
// notices evicted a sticky one. Bob's "your request was declined" toast — sticky, with nothing that
// re-raises it — vanished the moment several downloads were stopped at once.)
//
// The burst is the genuine one: the owner deletes files mid-download, and every pending row B holds
// is dropped with its own 8 s "removed by the owner" toast. Five files, so the pre-fix stack is
// certain to push the declined toast out; every row clearing is what proves the burst ran. B's
// downloads are capped at 1 MB/s so every row is still in flight when the files go. The files arrive
// one at a time because every row's button is named "Download": a started row stops offering it, so
// exactly one is ever targetable.
export default async function s147({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Burst')
  mkdirSync(ownDir, { recursive: true })
  const addFile = (name) => writeFileSync(path.join(ownDir, name), Buffer.alloc(64 * 1024 * 1024, 0x5a))
  addFile(FILES[0])

  const rowShown = async (name) => flatten(await B.snap()).some((n) => n.name === name)
  const removedToasts = async () => new Set([...allText(await B.snap()).matchAll(REMOVED)].map((m) => m[1]))

  try {
    await r.ok('A shares a folder with B; B caps its downloads at 1 MB/s', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.focus()
      await A.addOwnedFolder(ownDir)
      await A.waitText('Burst', 60000)
      await B.waitText('Burst', 60000)
      await B.focus()
      await B.gotoSettings('Network')
      await B.click({ name: 'Download limit: 1 MB/s' })
      await waitFor(async () => (await B.nodeValue({ name: 'Download limit: 1 MB/s' })) === '1', 8000, '1 MB/s pressed')
      await B.click({ role: 'button', name: 'Home' })
    })

    await r.ok('A declines Bob into a second space; Bob holds a sticky "declined" toast', async () => {
      await A.focus()
      await A.back()
      const code = await createSpaceWithInvite(A, { name: 'Beta' })
      await B.focus()
      await joinPending(B, code)
      await A.focus()
      await A.waitText('wants to join', 30000)
      await waitFor(async () => A.has({ role: 'button', name: 'Deny Bob' }), 10000, 'Deny Bob targetable')
      await A.click({ role: 'button', name: 'Deny Bob' })
      await waitFor(async () => B.hasText('declined'), 30000, 'Bob sees the request was declined')
      await B.shot('s147-B-declined', runDir)
    })

    await r.ok('B starts every download in the folder', async () => {
      await B.focus()
      await waitFor(async () => !(await B.hasText('Waiting to be let in')), 15000, 'denied pending space cleared')
      await B.click({ name: 'Open Aurora' })
      await B.openFolder('Burst')
      for (const [i, name] of FILES.entries()) {
        if (i > 0) addFile(name)
        await waitFor(() => rowShown(name), 60000, `${name} listed`)
        await waitFor(async () => B.has({ role: 'button', name: 'Download' }), 60000, `${name} downloadable`)
        await B.click({ role: 'button', name: 'Download' })
      }
      await waitFor(async () => !(await B.has({ role: 'button', name: 'Download' })), 30000, 'every row started')
      assert(await B.hasText('declined'), 'precondition: the declined toast is still up before the burst')
    })

    await r.ok('A deletes the files mid-download; the declined toast outlives the burst', async () => {
      assert(!(await B.hasText('On your device')), 'precondition: every download is still in flight')
      for (const name of FILES) rmSync(path.join(ownDir, name), { force: true })
      assert(FILES.every((name) => !existsSync(path.join(ownDir, name))), 'precondition: the files are gone')

      await B.waitText('removed by the owner', 30000)
      await sleep(1500)
      console.log(`[s147] removal toasts on screen: ${[...(await removedToasts())].join(', ')}`)
      assert(await B.hasText('declined'), 'the sticky declined toast was NOT evicted by the burst')
      for (const name of FILES) await waitFor(async () => !(await rowShown(name)), 60000, `${name} row dropped`)
      assert(await B.hasText('declined'), 'and it is still up once every row has dropped')
      await B.shot('s147-B-after-burst', runDir)
    })

    await r.ok('the stack held its cap; the sticky toast leaves only when dismissed', async () => {
      const shown = await removedToasts()
      assert(shown.size <= 3, `the stack held its cap: declined + ${shown.size} removal toasts`)
      await waitFor(async () => (await removedToasts()).size === 0, 20000, 'the timed toasts aged out')
      assert(await B.hasText('declined'), 'the declined toast outlived them')
      await B.click({ role: 'button', name: 'Dismiss' })
      await waitFor(async () => !(await B.hasText('declined')), 10000, 'Dismiss removes the sticky toast')
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B] }
}
