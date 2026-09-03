import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText, flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-PI12: an owned folder's local I/O fault had no surface at all. The status was
// recorded durably and read by nothing — every consumer of mount.status compared against
// 'mount-point-gone' or 'paused' — so the only sign was an 8-second toast carrying a raw errno
// string, gone on reload. Worse, the fault most likely to happen never even got that far: a
// publish that fails is counted per item and the pass still resolved, which settled the folder to
// 'active'.)
//
// The fault is induced through the genuine path: an unreadable file inside the shared folder. The
// watcher publishes it, the read fails EACCES, and the catch-up pass that follows settles the
// mount. Nothing here forces a status — this is the whole chain, which is why it belongs at this
// layer rather than as a rendered-given-state check.
export default async function s127 ({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')
  const secret = path.join(ownDir, 'sealed.txt')

  try {
    await r.ok('A shares "Reports" and it settles healthy', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Reports', 60000)
      await A.openFolder('Reports')
      await A.waitText('q1.txt', 20000)
      assert(!(await A.hasText('Problem')), 'precondition: a healthy folder shows no fault')
    })

    await r.ok('a file it cannot read surfaces the fault, named in plain language', async () => {
      writeFileSync(secret, 'cannot read this')
      chmodSync(secret, 0o000)
      await waitFor(async () => {
        const text = allText(await A.snap())
        return /couldn't be added/i.test(text) && /permission denied/i.test(text)
      }, 90000, 'the fault strip names the reason')
      assert(!/EACCES/i.test(allText(await A.snap())), 'and never the errno string it came from')
      await A.shot('s127-fault', runDir)
    })

    await r.ok('the fault carries a retry, and the tile agrees with the strip', async () => {
      const buttons = flatten(await A.snap()).filter((n) => n.role === 'button')
      assert(buttons.some((b) => /^try again$/i.test(b.label)), 'the owner cadence is six-hourly, so the strip carries the verb')
      assert(await A.hasText('Problem'), 'the tile pill reports it too, so the space screen agrees')
    })

    await r.ok('the fault survives a restart — it is durable state, not a toast', async () => {
      await A.quit()
      await A.launch({ onboard: false })
      await A.waitText('Aurora', 60000)
      await A.click({ name: 'Open Aurora' })
      await A.openFolder('Reports')
      await waitFor(async () => /couldn't be added/i.test(allText(await A.snap())), 90000,
        'the strip is back from the record, with no event to rebuild it from')
      await A.shot('s127-fault-after-restart', runDir)
    })

    await r.ok('fixing the file and pressing the verb clears it', async () => {
      chmodSync(secret, 0o644)
      // The strip's own verb, not a Pause/Resume detour: it runs a full pass, and the pass that
      // succeeds is the recovery. Nothing else would clear it here — the mount-point probe only
      // fires on a path that came back, and this path never went away.
      await A.click({ role: 'button', name: 'Try again' })
      await waitFor(async () => {
        const text = allText(await A.snap())
        return !/couldn't be added/i.test(text) && !/permission denied/i.test(text)
      }, 90000, 'the fault strip is gone')
      await A.waitText('sealed.txt', 60000)
      await A.shot('s127-cleared', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
