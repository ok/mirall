// Real-Chromium harness for the update mode. Mounts the REAL <UpdateModeRow>, <UpdateVerdictBanner>
// and <UpdateBanner> and asserts what each mode and state exposes: one pressed segment described by
// the sentence for the mode it shows, a change that reaches its handler and moves the pressed
// segment, an Update action wherever a version waits for the go-ahead, no sentence that promises
// background work under `never`, and a segment row that fits its card in every language.
import './harness-bootstrap.js'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import i18n, { SUPPORTED_LANGUAGES } from '../../src/renderer/platform/i18n.js'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import UpdateModeRow from '../../src/renderer/components/about/UpdateModeRow.js'
import UpdateVerdictBanner from '../../src/renderer/components/about/UpdateVerdictBanner.js'
import UpdateBanner from '../../src/renderer/components/layout/UpdateBanner.js'
import type { UpdateMode, UpdateStatus } from '../../src/shared/contract/update-status.js'

interface HarnessResults {
  pass: boolean
  error: string | null
  checks: Record<string, boolean>
  detail: Record<string, string>
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const BASE: UpdateStatus = { state: 'idle', nextVersion: null, lastCheckedAt: 1_700_000_000_000, offReason: null, canRestart: true, progress: null, waitingForPeers: false, mode: 'automatic', held: false }
const CARDS: Record<string, UpdateStatus> = {
  available: { ...BASE, state: 'available', nextVersion: '9.9.9', mode: 'notify' },
  held: { ...BASE, state: 'downloading', progress: 30, mode: 'notify', held: true },
  neverUnchecked: { ...BASE, lastCheckedAt: null, mode: 'never' },
  neverError: { ...BASE, state: 'error', mode: 'never' },
  upToDate: BASE,
}
const calls = { changes: [] as UpdateMode[], installs: 0, cardInstalls: 0, dismisses: 0 }
const noop = () => {}

function ModeHarness() {
  const [mode, setMode] = useState<UpdateMode>('notify')
  return (
    <UpdateModeRow
      mode={mode}
      onChange={async (next) => {
        calls.changes.push(next)
        await new Promise((resolve) => setTimeout(resolve, 50))
        setMode(next)
      }}
    />
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <ToastProvider>
    <div style={{ width: 672, padding: 24, display: 'grid', gap: 16 }}>
      <div data-test="mode"><ModeHarness /></div>
      {Object.entries(CARDS).map(([name, status]) => (
        <div key={name} data-test={name}>
          <UpdateVerdictBanner status={status} restarting={false} onCheck={noop} onRestart={noop} onInstall={() => { calls.cardInstalls++ }} />
        </div>
      ))}
      <div data-test="bannerAvailable">
        <UpdateBanner update={{ kind: 'available', version: '9.9.9' }} onDismiss={() => { calls.dismisses++ }} onInstall={() => { calls.installs++ }} />
      </div>
      <div data-test="bannerReady">
        <UpdateBanner update={{ kind: 'ready', version: '9.9.9' }} onDismiss={noop} onInstall={noop} />
      </div>
    </div>
  </ToastProvider>,
)

const scope = (name: string) => document.querySelector(`[data-test="${name}"]`) as HTMLElement
const buttons = (name: string) => [...scope(name).querySelectorAll('button')]
// A segment renders its label twice (a hidden ghost reserves the semibold width); the first copy is
// the one shown and named.
const labelOf = (b: HTMLButtonElement) => (b.querySelector('span > span') ?? b).textContent?.trim() ?? ''
const named = (name: string, label: string) => buttons(name).find((b) => labelOf(b) === label) ?? null
const body = (name: string) => scope(name).querySelectorAll('[role="status"] p')[1]?.textContent ?? ''
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function readMode() {
  const segments = buttons('mode')
  const pressed = segments.filter((b) => b.getAttribute('aria-pressed') === 'true')
  const descIds = new Set(segments.map((b) => b.getAttribute('aria-describedby')))
  const [descId] = [...descIds]
  return {
    count: segments.length,
    pressed: pressed.map(labelOf),
    oneDescription: descIds.size === 1 && !!descId,
    description: (descId && document.getElementById(descId)?.textContent) || '',
  }
}

// The segment row must not push past its card: the widest label set decides.
async function fitsInEveryLanguage(detail: Record<string, string>) {
  const fits: boolean[] = []
  for (const { code } of SUPPORTED_LANGUAGES) {
    await i18n.changeLanguage(code)
    await sleep(30)
    const row = scope('mode').firstElementChild as HTMLElement
    const line = row.firstElementChild as HTMLElement
    detail[`width.${code}`] = `${line.scrollWidth}/${line.clientWidth}`
    fits.push(line.scrollWidth <= line.clientWidth && row.scrollWidth <= row.clientWidth)
  }
  await i18n.changeLanguage('en')
  await sleep(30)
  return fits.every(Boolean)
}

async function main() {
  await sleep(300)
  const t = i18n.t.bind(i18n)
  const detail: Record<string, string> = {}
  const before = readMode()
  detail.before = JSON.stringify(before)

  flushSync(() => { named('mode', t('about.mode.never'))?.click() })
  const during = readMode()
  const busy = buttons('mode').every((b) => b.getAttribute('aria-disabled') === 'true')
  await sleep(200)
  const after = readMode()
  detail.after = JSON.stringify(after)

  named('available', t('about.install'))?.click()
  named('bannerAvailable', t('updateBanner.install'))?.click()
  named('bannerAvailable', t('updateBanner.later'))?.click()

  const checks: Record<string, boolean> = {
    'three segments, one pressed, all described by one sentence': before.count === 3 && before.pressed.length === 1 && before.oneDescription,
    'the sentence describes the pressed mode': before.pressed[0] === t('about.mode.notify') && before.description === t('about.mode.notifyDesc'),
    'a change shows at once and reads as busy until it lands': during.pressed[0] === t('about.mode.never') && busy,
    'the change reaches its handler once': calls.changes.join(',') === 'never',
    'after the change the new mode is pressed and described': after.pressed[0] === t('about.mode.never') && after.description === t('about.mode.neverDesc'),
    'a waiting version offers Update on the card': body('available') === t('about.verdict.availableBody') && calls.cardInstalls === 1,
    'a held download says it will not install on its own': body('held') === t('about.verdict.downloadingHeldBody'),
    'never promises no background look': body('neverUnchecked') === t('about.verdict.notCheckedManualBody') && body('neverError') === t('about.verdict.errorManualBody'),
    'automatic up to date says only when it checked': body('upToDate').startsWith(t('about.verdict.upToDateBody', { when: '' }).replace(/\.$/, '').trim()),
    'the waiting banner offers Update and Later': calls.installs === 1 && calls.dismisses === 1 && scope('bannerAvailable').querySelector('[role="status"]') !== null,
    'the staged banner keeps its single Dismiss': buttons('bannerReady').length === 1 && named('bannerReady', t('updateBanner.dismiss')) !== null,
    'the mode row fits its card in every language': await fitsInEveryLanguage(detail),
  }
  window.__results = { pass: Object.values(checks).every(Boolean), error: null, checks, detail }
}

main().catch((err) => {
  window.__results = { pass: false, error: err instanceof Error ? err.message : String(err), checks: {}, detail: {} }
})
