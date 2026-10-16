import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// OnboardingScreen validation: a whitespace-only display name keeps Continue disabled;
// a real name enables it and advances to the spaces screen.
export default async function s22({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch without auto-onboarding lands on the welcome screen', async () => {
      await A.launch({ onboard: false })
      await A.waitText('Welcome to Mirall', 45000)
    })
    // The AX tree carries no aria-describedby, so the help line's link to the field is pinned by the
    // `fields` layout harness; here the field is named by its label and the help line is shown.
    await r.ok('the name field is named by its label, with its help line', async () => {
      if (!(await A.has({ role: 'textfield', name: 'Display Name' }))) throw new Error('no textfield named "Display Name"')
      await A.waitText('This is how your team and friends will see you.', 8000)
    })
    await r.ok('a whitespace-only name keeps Continue disabled', async () => {
      await A.type({ role: 'textfield' }, '   ')
      await waitFor(async () => A.isDisabled({ role: 'button', name: 'Continue' }), 8000, 'Continue disabled')
      await A.shot('s22-disabled', runDir)
    })
    // MIR-12: maxLength={80} accepts an exactly-80-char name and the live counter shows the cap.
    await r.ok('an 80-char name shows the counter at the cap', async () => {
      await A.type({ role: 'textfield' }, 'q'.repeat(80))
      await A.waitText('80/80', 8000)
      await A.shot('s22-name-counter', runDir)
    })
    await r.ok('a real name enables Continue and advances', async () => {
      await A.type({ role: 'textfield' }, 'Real Name')
      await A.click({ role: 'button', name: 'Continue' })
      await A.waitText('Create Space', 30000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
