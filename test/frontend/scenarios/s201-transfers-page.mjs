import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'

// The transfers page is opened from the header on any screen, and Back returns to that screen
// rather than to a fixed parent.
export default async function s201({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  try {
    await r.ok('the header carries Transfers and Send Feedback as named buttons', async () => {
      await A.launch()
      await A.waitText('Create Space')
      assert(await A.has({ role: 'button', name: 'Transfers' }), 'no button named "Transfers" in the header')
      assert(await A.has({ role: 'button', name: 'Send Feedback' }), 'no button named "Send Feedback" in the header')
    })
    await r.ok('Transfers opens the page with its empty state', async () => {
      await A.click({ role: 'button', name: 'Transfers' })
      await A.waitText('No transfers right now')
      await A.shot('s201-transfers-empty', runDir)
    })
    await r.ok('Back returns to the spaces list', async () => {
      await A.back()
      await A.waitText('Create Space')
    })
    await r.ok('opened from Settings, Back returns to Settings', async () => {
      await A.openSettings()
      await A.click({ role: 'button', name: 'Transfers' })
      await A.waitText('No transfers right now')
      await A.back()
      await A.waitText('Manage your experience')
    })
    await r.ok('the command palette reaches the page', async () => {
      await A.press('cmd+k')
      await A.waitText('Type a command')
      await A.type({ role: 'combobox' }, 'transfers')
      await A.press('return')
      await A.waitText('No transfers right now')
    })
    await r.ok('a limit picked on the page is the one Network settings shows', async () => {
      await A.click({ name: 'Download limit: Unlimited' })
      await A.click({ name: '5 MB/s' })
      await waitFor(() => A.has({ name: 'Download limit: 5 MB/s' }), 8000, 'the trigger names the new limit')
      await A.shot('s201-transfers-limits', runDir)
      await A.click({ role: 'button', name: 'Network Settings' })
      await A.waitText('Limits for uploads and downloads.')
      await waitFor(async () => (await A.nodeValue({ name: 'Download limit: 5 MB/s' })) === '1', 8000, '5 MB/s pressed')
      await waitFor(async () => (await A.nodeValue({ name: 'Upload limit: Unlimited' })) === '1', 8000, 'upload untouched')
    })
    await r.ok('Back from Network settings returns to the page', async () => {
      await A.back()
      await A.waitText('No transfers right now')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
