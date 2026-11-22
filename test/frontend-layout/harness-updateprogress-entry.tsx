// Real-Chromium harness for About's update card while an update downloads. Mounts the REAL
// <UpdateVerdictBanner> in each state and asserts where the bar is and what it exposes: a
// percentage once the download is sized, a sweep before that, a standing bar and a different
// sentence while no peer is left, and no bar outside a download. The bar sits outside the card's
// live region, so progress is read from the bar's value and never announced per change.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import i18n from '../../src/renderer/platform/i18n.js'
import UpdateVerdictBanner from '../../src/renderer/components/about/UpdateVerdictBanner.js'
import type { UpdateStatus } from '../../src/shared/contract/update-status.js'

interface CardReading {
  hasBar: boolean
  barInLiveRegion: boolean
  name: string
  valueNow: string | null
  valueText: string
  sweep: boolean
  pctText: string
  body: string
}

interface HarnessResults {
  pass: boolean
  error: string | null
  cards: Record<string, CardReading>
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const BASE: UpdateStatus = { state: 'idle', nextVersion: null, lastCheckedAt: 1_700_000_000_000, offReason: null, canRestart: true, progress: null, waitingForPeers: false, mode: 'automatic', held: false }
const CARDS: Record<string, UpdateStatus> = {
  unsized: { ...BASE, state: 'downloading' },
  sized: { ...BASE, state: 'downloading', progress: 42 },
  waiting: { ...BASE, state: 'downloading', progress: 42, waitingForPeers: true },
  waitingUnsized: { ...BASE, state: 'downloading', waitingForPeers: true },
  ready: { ...BASE, state: 'ready', nextVersion: '9.9.9' },
  idle: BASE,
}
const noop = () => {}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ width: 672, padding: 24, display: 'grid', gap: 16 }}>
    {Object.entries(CARDS).map(([name, status]) => (
      <div key={name} data-test={name}>
        <UpdateVerdictBanner status={status} restarting={false} onCheck={noop} onRestart={noop} onInstall={noop} />
      </div>
    ))}
  </div>,
)

function readCard(name: string): CardReading {
  const scope = document.querySelector(`[data-test="${name}"]`) as HTMLElement
  const live = scope.querySelector('[role="status"]') as HTMLElement
  const bar = scope.querySelector('[role="progressbar"]')
  return {
    hasBar: bar !== null,
    barInLiveRegion: bar !== null && live.contains(bar),
    name: bar?.getAttribute('aria-label') ?? '',
    valueNow: bar?.getAttribute('aria-valuenow') ?? null,
    valueText: bar?.getAttribute('aria-valuetext') ?? '',
    sweep: bar?.querySelector('.progress-indeterminate') != null,
    pctText: bar?.previousElementSibling?.textContent ?? '',
    body: live.querySelectorAll('p')[1]?.textContent ?? '',
  }
}

setTimeout(() => {
  try {
    const cards = Object.fromEntries(Object.keys(CARDS).map((name) => [name, readCard(name)]))
    const { unsized, sized, waiting, waitingUnsized, ready, idle } = cards
    const downloading = [unsized, sized, waiting, waitingUnsized]
    const pass =
      downloading.every((c) => c.hasBar && !c.barInLiveRegion && c.name === i18n.t('about.downloadProgress')) &&
      !ready.hasBar && !idle.hasBar &&
      unsized.sweep && unsized.valueNow === null && unsized.valueText === i18n.t('format.progressUnknown') && unsized.pctText === '' &&
      !sized.sweep && sized.valueNow === '42' && sized.pctText === '42%' && sized.body === i18n.t('about.verdict.downloadingBody') &&
      !waiting.sweep && waiting.valueNow === '42' && waiting.body === i18n.t('about.verdict.downloadingWaitingBody') &&
      !waitingUnsized.sweep && waitingUnsized.valueNow === '0' && waitingUnsized.pctText === '' &&
      waitingUnsized.body === i18n.t('about.verdict.downloadingWaitingBody')
    window.__results = { pass, error: null, cards }
  } catch (err) {
    window.__results = { pass: false, error: err instanceof Error ? err.message : String(err), cards: {} }
  }
}, 300)
