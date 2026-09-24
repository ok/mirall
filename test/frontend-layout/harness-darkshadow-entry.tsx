// REGRESSION harness (FIX-DARKSHADOW: a tinted band under the first-run header in dark mode) for the
// ambient mauve shadow `rgba(74,59,82,…)`. It is the soft lift of floating chrome in light mode, but
// over a dark surface the mauve is lighter than what it falls on, so it paints a haze instead of a
// shadow. TopNav dropped it in dark mode; the first-run header and card did not.
//
// Mounts the REAL <OnboardingScreen> and <TopNav> and sweeps every element's computed box-shadow in
// both themes, so it catches any surface on these screens that carries the tint into dark mode.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import OnboardingScreen from './../../src/renderer/screens/OnboardingScreen.js'
import TopNav from './../../src/renderer/components/layout/TopNav.js'
import { ConnectionStatusProvider } from './../../src/renderer/hooks/useConnectionStatus.js'

interface Tinted {
  tag: string
  cls: string
  boxShadow: string
}

interface HarnessResults {
  pass: boolean
  error: string | null
  lightTinted: Tinted[]
  darkTinted: Tinted[]
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const noop = () => {}

createRoot(document.getElementById('root') as HTMLElement).render(
  <ConnectionStatusProvider>
    <TopNav
      profile={{ displayName: 'Alice', avatar: null } as never}
      onLogoClick={noop}
      onSettingsClick={noop}
      onAccountClick={noop}
      onFeedbackClick={noop}
      update={null}
      onDismissUpdate={noop}
    />
    <OnboardingScreen onComplete={() => Promise.resolve()} />
  </ConnectionStatusProvider>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publish(results: Partial<HarnessResults>): void {
  window.__results = { pass: false, error: null, lightTinted: [], darkTinted: [], ...results }
}

// Chromium serialises the computed colour with spaces, whatever the utility wrote.
const MAUVE = 'rgba(74, 59, 82'

function tinted(): Tinted[] {
  return Array.from(document.querySelectorAll('#root *'))
    .map((el) => ({ el, boxShadow: getComputedStyle(el).boxShadow }))
    .filter(({ boxShadow }) => boxShadow.includes(MAUVE))
    .map(({ el, boxShadow }) => ({ tag: el.tagName.toLowerCase(), cls: String(el.getAttribute('class') ?? ''), boxShadow }))
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  while (!document.querySelector('main') && Date.now() < deadline) await sleep(50)
  if (!document.querySelector('main')) return publish({ error: 'the first-run screen rendered no <main>' })
  await document.fonts.ready

  document.documentElement.classList.remove('dark')
  await sleep(100)
  const lightTinted = tinted()
  // The light theme is where the lift belongs; finding none there means the sweep cannot see the
  // tint at all, and an empty dark result would pass vacuously.
  if (lightTinted.length === 0) {
    return publish({ error: `no element carries the ${MAUVE},…) lift in light mode — the sweep would pass vacuously` })
  }

  document.documentElement.classList.add('dark')
  await sleep(100)
  const darkTinted = tinted()
  document.documentElement.classList.remove('dark')

  publish({ pass: darkTinted.length === 0, lightTinted, darkTinted })
}

run().catch((e) => publish({ error: String(e?.stack || e) }))
