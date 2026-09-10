import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Appearance settings: a zoom level applies (aria-pressed flips), an off-preset factor still marks
// exactly one tile, and switching the interface language re-renders visible strings
// (English → Deutsch → back). Theme switching is already covered by s8.

const ZOOM_TILES = ['Compact', 'Cozy', 'Default', 'Spacious']

async function pressedZoomTiles (A) {
  const pressed = []
  for (const label of ZOOM_TILES) {
    if ((await A.nodeValue({ name: label })) === '1') pressed.push(label)
  }
  return pressed
}

function storeHeldByApp (store) {
  try {
    execFileSync('pgrep', ['-f', `Electron.*${store}`], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// Editing a stopped instance's store is only safe once the app is really gone: quit() resolves on
// the `npx electron-forge` wrapper, whose Electron child can still be shutting down, and main's
// config store is debounced and flushed on before-quit — a flush that rewrites the WHOLE file, so
// an early edit is silently replaced by the factor the dying app held. Wait the app out, then read
// the edit back, so a clobber fails here by name instead of as a mystery timeout further down.
// The wait belongs in the harness's own stop; this is local until quit() awaits the real process.
async function seedPersistedZoom (A, factor) {
  await waitFor(async () => !storeHeldByApp(A.store), 20000, 'the quit app released its store')
  const configPath = join(A.store, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.window.zoom = factor
  writeFileSync(configPath, JSON.stringify(config))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const readBack = JSON.parse(readFileSync(configPath, 'utf8')).window.zoom
  if (readBack !== factor) {
    throw new Error(`seeded zoom ${factor} was clobbered: config.json holds ${readBack}`)
  }
}

export default async function s15 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Appearance settings', async () => {
      await A.launch()
      await A.gotoSettings('Appearance')
      await A.waitText('Appearance', 8000)
    })
    await r.ok('selecting a zoom level marks it pressed', async () => {
      await A.click({ name: 'Spacious' })
      await waitFor(async () => (await A.nodeValue({ name: 'Spacious' })) === '1', 8000, 'Spacious pressed')
      await A.shot('s15-zoom', runDir)
    })
    // The factor is one app-wide fact, so leaving the screen and coming back must not repaint it
    // at the 100% default while a fresh read is in flight.
    await r.ok('the chosen zoom is still shown after leaving and returning', async () => {
      await A.click({ name: 'Back' })
      await A.waitText('Manage your experience', 8000)
      await A.click({ name: 'Appearance' })
      await waitFor(async () => (await A.nodeValue({ name: 'Spacious' })) === '1', 8000, 'still Spacious')
    })
    // The menu and the keyboard chord step the factor by 0.05, so the persisted value usually
    // lands between two presets. The control marks the nearest one: 0.90 is Cozy (0.92), not
    // nothing — a screen reader must never be told no zoom is selected while one plainly is.
    await r.ok('a factor between presets marks exactly the nearest tile', async () => {
      await A.quit()
      await seedPersistedZoom(A, 0.90)
      await A.launch({ onboard: false })
      await A.gotoSettings('Appearance')
      await A.waitText('Appearance', 8000)
      await waitFor(async () => (await A.nodeValue({ name: 'Cozy' })) === '1', 8000, 'Cozy pressed at 0.90')
      const pressed = await pressedZoomTiles(A)
      if (pressed.join(',') !== 'Cozy') throw new Error(`expected only Cozy pressed, got [${pressed.join(',')}]`)
      await A.shot('s15-zoom-nearest', runDir)
    })
    await r.ok('switching language re-renders the UI, then switches back', async () => {
      await A.click({ name: 'Deutsch' })
      await A.waitText('Darstellung', 8000)
      await A.click({ name: 'English' })
      await A.waitText('Appearance', 8000)
      await A.shot('s15-language', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
