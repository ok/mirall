import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// The update mode: chosen in Settings → General, shown at work on About. A source build has no
// update drive, so the app is launched with MIRALL_UPDATE_PREVIEW, whose stand-in updater offers
// v99.0.0 through the production mode control. Automatic mode downloads and stages it unasked;
// choosing "Notify me" in General sends the staged update back to waiting; About's card and the
// banner then offer Update, and Update makes it ready again.
export default async function s203({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: { MIRALL_UPDATE_PREVIEW: '99.0.0' } })

  try {
    await r.ok('launch', async () => {
      await A.launch()
    })
    await r.ok('in automatic mode the offered version downloads and is staged unasked', async () => {
      await A.waitText('App update available (v99.0.0)', 30000)
      await A.openAccount()
      await A.click({ role: 'button', name: 'About Mirall' })
      await A.waitText('Update ready: v99.0.0', 8000)
      await A.shot('s203-automatic-ready', runDir)
    })
    await r.ok('"Notify me" is chosen in Settings → General', async () => {
      await A.openSettings()
      await A.click({ role: 'button', name: 'General' })
      await A.waitText('New versions download on their own and install when you reopen Mirall.', 8000)
      await A.click({ name: 'Notify me' })
      await A.waitText('New versions are shown, and download only when you choose Update.', 8000)
      if ((await A.nodeValue({ name: 'Notify me' })) !== '1') throw new Error('Notify me is not the pressed segment')
      await A.shot('s203-general-notify', runDir)
    })
    await r.ok('the staged update goes back to waiting for the go-ahead', async () => {
      await A.waitText('Mirall v99.0.0 is available', 8000)
      if (!(await A.has({ role: 'button', name: 'Later' }))) throw new Error('the banner offers no Later')
      await A.openAccount()
      await A.click({ role: 'button', name: 'About Mirall' })
      await A.waitText('Update available: v99.0.0', 8000)
      await A.shot('s203-notify-available', runDir)
    })
    await r.ok('Later hides the banner and leaves the card offering Update', async () => {
      await A.click({ role: 'button', name: 'Later' })
      const deadline = Date.now() + 8000
      while (await A.hasText('Mirall v99.0.0 is available')) {
        if (Date.now() > deadline) throw new Error('the banner is still shown after Later')
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      await A.waitText('Update available: v99.0.0', 8000)
    })
    await r.ok('Update on the card makes the staged version ready', async () => {
      await A.click({ role: 'button', name: 'Update' })
      await A.waitText('Update ready: v99.0.0', 8000)
      await A.shot('s203-notify-approved', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
