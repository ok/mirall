import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText } from '../tree.mjs'

// Applying a new relay identity replaces the worker process. The window no longer reloads to
// recover from that, so nothing tears the React tree down: the screen stays where it is, the
// history it remembers is still true, and the lists re-read in place rather than blanking. The
// vector is the frozen invite ticket from the relay↔client contract, as s137 uses.
const TICKET = 'mirall://relay/ygqac38xcbqmffk19weyomkrzhny5qbt5oag7iqzbwscj4b88h7758musqus5hrut9afmj5qjorsaigcrtpumig5gg4af6i4uzxjjm1qhz55ppy'

export default async function s152({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Restart', bootstrap, slot: 0, total: 1 })

  // Samples the whole tree while `goal` arrives, failing the moment `forbidden` appears. s117's
  // shape: a blank frame between the old data and the new read is the thing under test, and it is
  // only observable while the read is in flight.
  const watch = async (goal, forbidden, timeout = 30000) => {
    const deadline = Date.now() + timeout
    let samples = 0
    while (Date.now() < deadline) {
      const text = allText(await A.snap())
      samples++
      assert(!text.includes(forbidden), `"${forbidden}" flashed while ${goal} was loading (sample ${samples})`)
      if (text.includes(goal)) return samples
    }
    throw new Error(`timed out waiting for "${goal}" (${timeout}ms, ${samples} samples)`)
  }

  try {
    await r.ok('a space exists, and Settings is opened from inside it', async () => {
      await A.launch()
      await A.createSpaceOnly('Resume')
      await A.back()
      await A.waitText('Open Resume', 20000)
      await A.click({ name: 'Open Resume' })
      await A.waitText('Members', 30000)
      // Opening Settings from a space is what makes Back mean "the space", and that memory lives
      // nowhere but the renderer — a reload would silently reset it to the space list.
      await A.openSettings()
      await A.click({ name: 'Network' })
      await A.waitText('A relay helps two devices connect', 8000)
    })

    await r.ok('a private relay is configured, leaving the reconnect pending', async () => {
      await A.click({ name: 'Add relay' })
      await A.waitText('Add a relay', 8000)
      await A.type({ name: 'Relay key or invite' }, TICKET)
      await A.click({ name: 'Continue' })
      await A.waitText('Private relay', 8000)
      await A.type({ name: 'Name (optional)' }, 'Family relay')
      await A.click({ name: 'Add relay' })
      await A.waitText('Family relay', 15000)
      if (!(await A.has({ name: 'Reconnect now' }))) throw new Error('no way to apply the new identity')
    })

    await r.ok('the restart leaves the user exactly where they were', async () => {
      await A.click({ name: 'Reconnect now' })
      await waitFor(async () => !(await A.has({ name: 'Reconnect now' })), 30000, 'the restart to apply')
      // A reload would have landed on the space list. The assertion is the ABSENCE of that trip.
      assert(await A.hasText('Family relay'), 'still on Network settings after the worker came back')
      assert(!(await A.hasText('Open Resume')), 'the window never went back to the space list')
      await A.shot('s152-after-restart', runDir)
    })

    await r.ok('and Back still remembers the space Settings was opened from', async () => {
      await A.back()
      await A.waitText('Manage your experience', 8000)
      await A.back()
      // 'spaces' is the default this state falls back to, so landing there is exactly the symptom a
      // reload used to produce.
      await A.waitText('Members', 20000)
      assert(!(await A.hasText('Open Resume')), 'Back went to the space, not to the root')
    })

    // What this measures is a COLD mount, not the keep-data window. The restart can only be asked
    // for from Settings ▸ Network, where the space list has no subscriber, so `resyncQueries` drops
    // that entry and the next visit refetches it from scratch — there is no screen showing the list
    // while the restart lands for the harness to sample. The keep-data path (a watched entry whose
    // value survives the new generation) is asserted where it is observable, in query-store.test.js.
    await r.ok('the space list cold-mounts after the restart without flashing its empty state', async () => {
      await A.back()
      const samples = await watch('Open Resume', 'No spaces yet')
      console.log(`s152: the space list rendered clean over ${samples} sample(s)`)
      await A.shot('s152-list-clean', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A] }
}
