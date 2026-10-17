// Info strip harness. The busy strips (a running batch, a working folder) stand off the page and
// everything on them reads, in both themes: the strip against the page, its sentence, the lane's
// percentage, the lane's fill against its track and its track against the strip, the indeterminate
// sweep, and the standard secondary button's label.
//
// Mounts the REAL <BatchProgressStrip> and <FolderWorkStrip> (determinate mirroring and indeterminate
// indexing) on the page surface and measures painted colour: every computed colour is composited onto
// a canvas over the backgrounds behind it, so the lane's alpha track is judged as it is seen. A strip
// class Tailwind never emitted paints nothing, which reads as the page and fails here.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import BatchProgressStrip from '../../src/renderer/components/batch/BatchProgressStrip.js'
import FolderWorkStrip from '../../src/renderer/components/folder/FolderWorkStrip.js'
import type { FolderStrip } from '../../src/renderer/model/folder-strips.js'

type Rgb = [number, number, number]

interface StripResult {
  strip: string
  offPage: number
  sentence: number
  meta: number | null
  fillVsTrack: number | null
  trackVsStrip: number
  sweepVsTrack: number | null
  buttonLabel: number
  isContainer: boolean
}

interface ThemeResult { theme: 'light' | 'dark', strips: StripResult[] }

interface HarnessResults {
  pass: boolean
  error: string | null
  themes: ThemeResult[]
  failures: string[]
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const noop = () => {}

const mirroring: FolderStrip = {
  id: 'working', tone: 'info', icon: 'update', live: null, action: 'pause',
  data: { kind: 'mirroring', scanning: false, files: 12, bytes: 4_000_000_000, indeterminate: false, pct: 34 },
}
const indexing: FolderStrip = {
  id: 'working', tone: 'info', icon: 'update', live: null, action: 'pause',
  data: { kind: 'indexing', scanning: false, files: 12, bytes: 4_000_000_000, indeterminate: true, pct: null },
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div data-probe="page" className="bg-surface p-8 space-y-4">
    <div data-probe="batch"><BatchProgressStrip progress={{ files: 9, done: 8, bytesLeft: 3_800_000_000, pct: 34, moving: true, batchLive: true, transferIds: [] }} onCancelAll={noop} /></div>
    <div data-probe="mirroring"><FolderWorkStrip strip={mirroring} ownerName="Chris" onAction={noop} /></div>
    <div data-probe="indexing"><FolderWorkStrip strip={indexing} ownerName="Chris" onAction={noop} /></div>
    <div data-probe="container" className="bg-info-container h-4" />
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publish(results: Partial<HarnessResults>): void {
  window.__results = { pass: false, error: null, themes: [], failures: [], ...results }
}

const canvas = document.createElement('canvas')
canvas.width = 1
canvas.height = 1
const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D

// Paints each colour in order over the last, and reads back the sRGB pixel the eye would see.
function paint(layers: string[]): Rgb {
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1, 1)
  for (const c of layers) {
    ctx.fillStyle = c
    ctx.fillRect(0, 0, 1, 1)
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a: Rgb, b: Rgb) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const same = (a: Rgb, b: Rgb) => a.every((v, i) => Math.abs(v - b[i]) <= 1)

// Every background from the root down to `el`, outermost first: what is painted behind it.
function grounds(el: Element): string[] {
  const out: string[] = []
  for (let n: Element | null = el; n; n = n.parentElement) out.unshift(getComputedStyle(n).backgroundColor)
  return out
}
const bg = (el: Element) => paint(grounds(el))
const ink = (el: Element) => paint([...grounds(el), getComputedStyle(el).color])

function q(root: Element, selector: string): Element {
  const el = root.querySelector(selector)
  if (!el) throw new Error(`missing ${selector}`)
  return el
}

function measureStrip(name: string): StripResult {
  const probe = q(document.body, `[data-probe="${name}"]`)
  const strip = q(probe, ':scope > div')
  const sentence = q(strip, ':scope > span')
  const bar = q(strip, '[role="progressbar"]')
  const meta = bar.previousElementSibling
  const fill = bar.querySelector(':scope > div:not(.progress-indeterminate)')
  const sweep = bar.querySelector('.progress-indeterminate')
  const button = q(strip, 'button')
  const stripBg = bg(strip)
  const track = bg(bar)
  return {
    strip: name,
    offPage: contrast(stripBg, bg(q(document.body, '[data-probe="page"]'))),
    sentence: contrast(ink(sentence), stripBg),
    meta: meta && meta.textContent ? contrast(ink(meta), stripBg) : null,
    fillVsTrack: fill ? contrast(bg(fill), track) : null,
    trackVsStrip: contrast(track, stripBg),
    sweepVsTrack: sweep ? contrast(bg(sweep), track) : null,
    buttonLabel: contrast(ink(button), bg(button)),
    isContainer: same(stripBg, bg(q(document.body, '[data-probe="container"]'))),
  }
}

// 1.2:1 is the separation the design accepts for a track or a surface off its host (the resting
// file card's floor); text takes 4.5:1, a bar's fill 3:1 against its track.
function check(theme: string, m: StripResult): string[] {
  const out: string[] = []
  const at = `${theme} ${m.strip}`
  if (!m.isContainer) out.push(`${at}: the strip is not painted info-container`)
  if (m.offPage < 1.2) out.push(`${at}: strip vs page ${m.offPage.toFixed(2)}:1`)
  if (m.sentence < 4.5) out.push(`${at}: sentence ${m.sentence.toFixed(2)}:1`)
  if (m.meta !== null && m.meta < 4.5) out.push(`${at}: lane meta ${m.meta.toFixed(2)}:1`)
  if (m.fillVsTrack !== null && m.fillVsTrack < 3) out.push(`${at}: fill vs track ${m.fillVsTrack.toFixed(2)}:1`)
  if (m.sweepVsTrack !== null && m.sweepVsTrack < 3) out.push(`${at}: sweep vs track ${m.sweepVsTrack.toFixed(2)}:1`)
  if (m.trackVsStrip < 1.2) out.push(`${at}: track vs strip ${m.trackVsStrip.toFixed(2)}:1`)
  if (m.buttonLabel < 4.5) out.push(`${at}: button label ${m.buttonLabel.toFixed(2)}:1`)
  return out
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  while (!document.querySelector('[data-probe="indexing"] [role="progressbar"]') && Date.now() < deadline) await sleep(50)
  if (!document.querySelector('[data-probe="indexing"] [role="progressbar"]')) return publish({ error: 'the strips did not render' })

  const failures: string[] = []
  const themes: ThemeResult[] = []
  for (const theme of ['light', 'dark'] as const) {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    // Buttons and the fill carry transitions: measured too early they read a blend of two themes.
    await sleep(600)
    const strips = ['batch', 'mirroring', 'indexing'].map(measureStrip)
    themes.push({ theme, strips })
    for (const m of strips) failures.push(...check(theme, m))
  }
  document.documentElement.classList.remove('dark')

  // Every measured lane has to have been measured: a selector that matches nothing would pass vacuously.
  const all = themes.flatMap((t) => t.strips)
  if (!all.some((m) => m.fillVsTrack !== null)) failures.push('no determinate fill was measured')
  if (!all.some((m) => m.sweepVsTrack !== null)) failures.push('no indeterminate sweep was measured')
  if (themes[0].strips[0].sentence === themes[1].strips[0].sentence) failures.push('the theme switch did not change the strip')

  publish({ pass: failures.length === 0, themes, failures })
}

run().catch((e) => publish({ error: String(e?.stack || e) }))
