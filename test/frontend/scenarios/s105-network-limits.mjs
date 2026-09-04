import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Settings ▸ Network: transfer caps. Covers the preset control, the Custom input and its
// floor advisory, persistence across a reopen, and the rule that this screen carries NO
// live network state (status lives on the account screen).
export default async function s105 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Network settings', async () => {
      await A.launch()
      await A.gotoSettings('Network')
      await A.waitText('Transfer limits', 8000)
    })

    await r.ok('defaults to Unlimited in both directions', async () => {
      await waitFor(async () => (await A.nodeValue({ name: 'Download limit: Unlimited' })) === '1', 8000, 'download unlimited')
      await waitFor(async () => (await A.nodeValue({ name: 'Upload limit: Unlimited' })) === '1', 8000, 'upload unlimited')
      await A.shot('s105-default', runDir)
    })

    // §7.0 — a settings screen answers "what did I choose", not "what is true now".
    await r.ok('carries no live network state', async () => {
      if (await A.hasText('peers connected')) throw new Error('peer count leaked onto the settings screen')
      if (await A.has({ name: 'Network status' })) throw new Error('diagnostics link leaked onto the settings screen')
    })

    await r.ok('selecting a preset marks it pressed', async () => {
      await A.click({ name: 'Download limit: 5 MB/s' })
      await waitFor(async () => (await A.nodeValue({ name: 'Download limit: 5 MB/s' })) === '1', 8000, '5 MB/s pressed')
      await waitFor(async () => (await A.nodeValue({ name: 'Download limit: Unlimited' })) === '0', 8000, 'Unlimited released')
    })

    await r.ok('Custom reveals the KB/s input', async () => {
      await A.click({ name: 'Upload limit: custom' })
      await A.waitText('Upload limit in KB/s', 8000)
      await A.shot('s105-custom', runDir)
    })

    // Targeted by accessible name (from its <label for>), not by role: that is the
    // contract the a11y bar actually requires of the control.
    await r.ok('a below-floor value surfaces the clamp advisory', async () => {
      await A.type({ name: 'Upload limit in KB/s' }, '12')
      await A.waitText('at least 32 KB/s', 8000)
      await A.shot('s105-advisory', runDir)
    })

    // The worker enforces the same floor, so without this the field would keep reading 12
    // while transfers actually ran at 32 — the stored setting and the effective rate
    // diverging permanently, with only the advisory sentence hinting at it.
    await r.ok('a below-floor value is raised to the floor on commit', async () => {
      await A.press('return')
      await waitFor(
        async () => (await A.nodeValue({ name: 'Upload limit in KB/s' })) === '32',
        8000,
        'field shows the committed floor, not the rejected draft',
      )
      await A.shot('s105-clamped', runDir)
    })

    await r.ok('a valid custom value echoes its MB/s equivalent', async () => {
      await A.type({ name: 'Upload limit in KB/s' }, '768')
      await A.waitText('About', 8000)
    })

    await r.ok('both the preset and the committed custom value survive a reopen', async () => {
      // Leaving the field commits the draft; the screen change also proves it persisted.
      await A.click({ name: 'Back' })
      await A.waitText('Manage your experience', 8000)
      await A.click({ name: 'Network' })
      await A.waitText('Transfer limits', 8000)
      await waitFor(async () => (await A.nodeValue({ name: 'Download limit: 5 MB/s' })) === '1', 8000, '5 MB/s still pressed')
      await waitFor(async () => (await A.nodeValue({ name: 'Upload limit: custom' })) === '1', 8000, 'custom still pressed')
      await A.waitText('Upload limit in KB/s', 8000)
      await A.shot('s105-persisted', runDir)
    })

    // The cap the screen shows is the cap that was STORED. A below-floor entry is the reachable
    // way to make those two differ, so the field must end on the clamped value, never on what was
    // typed — and never on a value no write ever persisted.
    await r.ok('a clamped write leaves the screen on the stored value, not the typed one', async () => {
      await A.click({ name: 'Download limit: custom' })
      await A.waitText('Download limit in KB/s', 8000)
      await A.type({ name: 'Download limit in KB/s' }, '3')
      await A.press('return')
      await waitFor(
        async () => (await A.nodeValue({ name: 'Download limit in KB/s' })) === '32',
        8000,
        'the screen shows what was stored',
      )
    })

    // Reopening paints from the shared copy of the caps. Checked with NO wait first: a screen
    // re-reading from scratch would be sitting on its Unlimited default at this instant, which is
    // a positive claim about the user's configuration made from no data.
    await r.ok('reopening shows the stored caps with no Unlimited flash', async () => {
      await A.click({ name: 'Back' })
      await A.waitText('Manage your experience', 8000)
      await A.click({ name: 'Network' })
      if ((await A.nodeValue({ name: 'Download limit: Unlimited' })) === '1') {
        throw new Error('the caps flashed back to Unlimited before the cached value painted')
      }
      await A.waitText('Transfer limits', 8000)
      await A.shot('s105-cached-reopen', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
