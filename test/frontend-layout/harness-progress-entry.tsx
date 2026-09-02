// Real-Chromium harness for the download/upload progress lane. Mounts the REAL
// <DownloadProgressLane> in both states and asserts the ARIA progressbar contract:
// indeterminate (ETA warmup) drops aria-valuenow and runs the sweep; determinate
// exposes aria-valuenow + a valuetext that carries the percentage. Also checks the
// real resolveEta logic: null = "Estimating…"/indeterminate, 0/undefined = hidden,
// > 0 = formatted, and a >0 eta with a decayed (0) speed = stalled → hidden.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import i18n from './../../src/renderer/i18n.js'
import DownloadProgressLane from './../../src/renderer/components/widgets/DownloadProgressLane.js'
import { resolveEta, etaFromRate } from './../../src/renderer/utils.js'

interface HarnessResults {
  pass: boolean
  error: string | null
  estimatingText: string
  indNoValueNow: boolean
  indHasSweep: boolean
  indValueText: string
  detHasValueNow: boolean
  detValueNow: number | null
  detHasSweep: boolean
  detValueText: string
  verValueNow: number | null
  verMetaText: string
  unmNoValueNow: boolean
  unmHasSweep: boolean
  unmValueText: string
  unmMetaText: string
  mapNull: string
  mapZero: string
  mapUndefined: string
  mapPositive: string
  mapStalled: string
  mapLive: string
  rateComplete: string
  rateIdle: string
  rateLive: string
  nullIndeterminate: boolean
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const container = document.getElementById('root') as HTMLElement
const warm = resolveEta(null)
const settled = resolveEta(11100)
const unknownText = i18n.t('format.progressUnknown')

createRoot(container).render(
  <div style={{ width: 220 }}>
    <div data-test="ind">
      <DownloadProgressLane value={0} label="Download progress" eta={warm.etaText} indeterminate={warm.indeterminate} />
    </div>
    <div data-test="det">
      <DownloadProgressLane value={42} label="Download progress" eta={settled.etaText} indeterminate={settled.indeterminate} speed="2 MB/s" />
    </div>
    <div data-test="ver">
      <DownloadProgressLane value={73} label="Verifying" showPct />
    </div>
    {/* The folder work strip's case: indeterminate with NO eta, because this lane never resolves
        one — the meta line stays empty and the accessible value has to come from elsewhere. */}
    <div data-test="unm">
      <DownloadProgressLane value={0} label="Indexing progress" indeterminate indeterminateText={unknownText} />
    </div>
  </div>,
)

function readBar(scopeSel: string): { valueNow: string | null; valueText: string; sweep: boolean } {
  const scope = document.querySelector(scopeSel) as HTMLElement
  const bar = scope.querySelector('[role="progressbar"]') as HTMLElement
  return {
    valueNow: bar.getAttribute('aria-valuenow'),
    valueText: bar.getAttribute('aria-valuetext') ?? '',
    sweep: bar.querySelector('.progress-indeterminate') !== null,
  }
}

setTimeout(() => {
  try {
    const ind = readBar('[data-test="ind"]')
    const det = readBar('[data-test="det"]')
    const ver = readBar('[data-test="ver"]')
    const verMeta = (document.querySelector('[data-test="ver"] p') as HTMLElement)?.textContent ?? ''
    const unm = readBar('[data-test="unm"]')
    const unmMeta = (document.querySelector('[data-test="unm"] p') as HTMLElement)?.textContent ?? ''
    const results: HarnessResults = {
      error: null,
      estimatingText: warm.etaText,
      indNoValueNow: ind.valueNow === null,
      indHasSweep: ind.sweep,
      indValueText: ind.valueText,
      detHasValueNow: det.valueNow !== null,
      detValueNow: det.valueNow !== null ? Number(det.valueNow) : null,
      detHasSweep: det.sweep,
      detValueText: det.valueText,
      verValueNow: ver.valueNow !== null ? Number(ver.valueNow) : null,
      verMetaText: verMeta,
      unmNoValueNow: unm.valueNow === null,
      unmHasSweep: unm.sweep,
      unmValueText: unm.valueText,
      unmMetaText: unmMeta,
      mapNull: warm.etaText,
      mapZero: resolveEta(0).etaText,
      mapUndefined: resolveEta(undefined).etaText,
      mapPositive: settled.etaText,
      mapStalled: resolveEta(11100, 0).etaText,
      mapLive: resolveEta(11100, 5).etaText,
      // Serve-side ETA: complete pull and idle (0 B/s) both hide; a live pull formats.
      rateComplete: etaFromRate(100, 100, 5),
      rateIdle: etaFromRate(50, 100, 0),
      rateLive: etaFromRate(50, 100, 5),
      nullIndeterminate: warm.indeterminate,
      pass: false,
    }
    results.pass =
      results.indNoValueNow &&
      results.indHasSweep &&
      results.indValueText === results.estimatingText &&
      results.estimatingText.length > 0 &&
      results.estimatingText !== 'format.etaEstimating' &&
      results.nullIndeterminate &&
      results.detHasValueNow &&
      results.detValueNow === 42 &&
      !results.detHasSweep &&
      results.detValueText.includes('42%') &&
      // Verifying: determinate bar + the percent rendered VISIBLY in the meta line
      // (not only in aria-valuetext), since there's no speed/ETA to show.
      results.verValueNow === 73 &&
      results.verMetaText.includes('73%') &&
      // Unmeasurable work: nothing visible, but never a bar with neither valuenow nor valuetext.
      results.unmNoValueNow &&
      results.unmHasSweep &&
      results.unmMetaText.trim() === '' &&
      results.unmValueText.length > 0 &&
      results.unmValueText !== 'format.progressUnknown' &&
      results.mapZero === '' &&
      results.mapUndefined === '' &&
      results.mapPositive.length > 0 &&
      results.mapPositive !== '11100' &&
      results.mapStalled === '' &&
      results.mapLive.length > 0 &&
      results.rateComplete === '' &&
      results.rateIdle === '' &&
      // Pin the exact value: etaFromRate(50,100,5) → remaining 50 ÷ 5 = 10s. Catches a
      // remaining-vs-total or unit mistake that still yields a formatted string.
      results.rateLive === '10s left'
    window.__results = results
  } catch (e) {
    window.__results = {
      pass: false,
      error: e instanceof Error ? e.message : String(e),
      estimatingText: '',
      indNoValueNow: false,
      indHasSweep: false,
      indValueText: '',
      detHasValueNow: false,
      detValueNow: null,
      detHasSweep: false,
      detValueText: '',
      verValueNow: null,
      verMetaText: '',
      mapNull: '',
      mapZero: '',
      mapUndefined: '',
      mapPositive: '',
      mapStalled: '',
      mapLive: '',
      rateComplete: '',
      rateIdle: '',
      rateLive: '',
      nullIndeterminate: false,
    }
  }
}, 60)
