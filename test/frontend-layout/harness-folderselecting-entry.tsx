// Selection-column geometry on the folder screen (LOCAL/dev-machine only — spawns a real Electron
// GUI process). Mounts the REAL <FolderScreen> on a browse folder three levels deep, opens the
// selection column with the select-all chord while the controls row's "Downloads to" button holds
// focus, and measures what the eye would otherwise have to: at rest the first row starts where the
// controls row starts; with the column open every box sits at ONE x whatever its depth, with room
// for its focus ring inside the scroll pane; the document never grows a scrollbar in either state.
// At rest "Downloads to" sits between the filter and Expand all; while selecting it is gone and
// the focus it held is on the top box, not the page (REGRESSION (FIX-DLTO-R18: the button left the
// row with focus in it)); the strip's split Download button's two halves share Done's height and
// baseline, with no Cancel beside them. Mounting the screen asks the worker nothing about the
// folders' reachability (REGRESSION (FIX-DLTO-R30: every screen mount re-probed every folder)), and
// with the space's folder reported offline the main half is inert, while clicking it or opening the
// Download-to menu asks the worker to look again, so a drive plugged back in counts at once
// (REGRESSION (FIX-DLTO-R23: an offline folder stayed blocked until the next minute's probe)).
import './harness-bootstrap.js'
import { controlsGeometry, splitGeometry, type ControlsGeometry, type SplitGeometry } from './download-to-geometry.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from '../../src/renderer/keyboard/KeyboardProvider.js'
import FolderScreen from '../../src/renderer/screens/FolderScreen.js'
import type { ShareFileRow } from '../../src/renderer/types/types.js'

interface Results {
  width: number
  atRestAligned: boolean
  restRowLeft: number
  restControlsLeft: number
  boxes: number
  boxLefts: number[]
  oneX: boolean
  ringRoom: number
  overflowAtRest: boolean
  overflowSelecting: boolean
  pass: boolean
  barLeft: number
  filterLeft: number
  barAligned: boolean
  downloadsTo: ControlsGeometry | null
  downloadsToHiddenSelecting: boolean
  /** What holds focus once the chord pressed on "Downloads to" opened the column. */
  focusAfterChord: string
  /** downloads:roots-status reads the screen sent before anything was clicked. */
  rootsReadsOnMount: number
  inertWhenOffline: boolean
  reprobedOnClick: boolean
  enabledAfterReprobe: boolean
  reprobedOnOpen: boolean
  split: SplitGeometry | null
  error: string | null
}

declare global {
  interface Window {
    __fake: { SPACE_ID: string; SHARE_ID: string; OWNER_PK: string; SELF_PK: string }
    __fakeEmit: (frame: { type: string; unavailable: string[] }) => void
    __fakeRequests: Record<string, number>
    __HARNESS_CFG?: { shareFiles?: ShareFileRow[] }
    __results: Results
  }
}

const f = window.__fake

const PATHS = ['Contracts/Agreement.pdf', 'Contracts/Invoice.pdf', 'Photos/raw/deep/x.cr3', 'Photos/raw/y.cr3', 'Photos/z.jpg', 'Floorplan.pdf', 'Notes.md']
const shareFiles: ShareFileRow[] = PATHS.map((relPath, i) => ({
  relPath, size: 1_000_000 + i, hash: 'h'.repeat(64), mtime: 0, status: i === 1 ? 'downloaded' : 'remote', localPath: null,
}))
window.__HARNESS_CFG = { shareFiles }

const share = {
  id: f.SHARE_ID,
  type: 'owned-folder',
  name: 'Handover',
  owner: f.OWNER_PK,
  spaceId: f.SPACE_ID,
  createdAt: 0,
  role: 'browse',
} as unknown as Parameters<typeof FolderScreen>[0]['share']

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="min-h-screen bg-surface">
    <main className="pt-[calc(5rem+var(--banner-h,0px))]">
      <ToastProvider>
        <KeyboardProvider currentScreen="folder-view" selectedSpaceId={f.SPACE_ID}>
          <FolderScreen spaceId={f.SPACE_ID} share={share} onBack={() => {}} />
        </KeyboardProvider>
      </ToastProvider>
    </main>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const RING = 2

// The selection strip's left edge against the filter field's, both after the column opened.
function barAlignment() {
  const bar = Array.from(document.querySelectorAll<HTMLElement>('main div')).filter((el) => el.className.includes('rounded-lg') && /\d+ selected/.test(el.textContent ?? '')).at(-1)
  const filter = document.querySelector<HTMLElement>('input[type=search]')?.parentElement ?? null
  const barLeft = bar ? Math.round(bar.getBoundingClientRect().left * 100) / 100 : -1
  const filterLeft = filter ? Math.round(filter.getBoundingClientRect().left * 100) / 100 : -2
  return { barLeft, filterLeft, barAligned: Math.abs(barLeft - filterLeft) <= 0.5 }
}

function pane(): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('main div'))) {
    if (getComputedStyle(el).overflowY === 'auto') return el
  }
  return null
}

const documentOverflows = () =>
  document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 ||
  document.documentElement.scrollHeight > document.documentElement.clientHeight + 1

function publish(partial: Partial<Results> & { pass: boolean; error: string | null }) {
  window.__results = {
    width: window.innerWidth, atRestAligned: false, restRowLeft: -1, restControlsLeft: -1, boxes: 0, boxLefts: [], oneX: false,
    ringRoom: -1, overflowAtRest: false, overflowSelecting: false, barLeft: -1, filterLeft: -2, barAligned: false,
    downloadsTo: null, downloadsToHiddenSelecting: false, focusAfterChord: '', rootsReadsOnMount: -1,
    inertWhenOffline: false, reprobedOnClick: false, enabledAfterReprobe: false, reprobedOnOpen: false, split: null, ...partial,
  }
}

const rootsReads = () => window.__fakeRequests['downloads:roots-status'] ?? 0
const mainHalf = () => document.querySelector<HTMLButtonElement>('[role=group][aria-label="Download"] button')

async function folderGoesOffline(): Promise<void> {
  window.__fakeEmit({ type: 'event:download-roots-status', unavailable: ['/Users/you/Downloads'] })
  await sleep(150)
}

// With the space's folder offline: the main half is inert, and a click on it, then opening the
// chevron's menu, each send one re-probe. The fake answers that nothing is offline any more.
async function actOnOfflineFolder() {
  await folderGoesOffline()
  const inertWhenOffline = mainHalf()?.getAttribute('aria-disabled') === 'true'
  const beforeClick = rootsReads()
  mainHalf()?.click()
  await sleep(200)
  const reprobedOnClick = rootsReads() === beforeClick + 1
  const enabledAfterReprobe = mainHalf() !== null && mainHalf()?.getAttribute('aria-disabled') !== 'true'
  await folderGoesOffline()
  const beforeOpen = rootsReads()
  const chevron = document.querySelector<HTMLButtonElement>('button[aria-label="More download options"]')
  chevron?.focus()
  chevron?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  await sleep(200)
  const reprobedOnOpen = rootsReads() === beforeOpen + 1
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await sleep(150)
  return { inertWhenOffline, reprobedOnClick, enabledAfterReprobe, reprobedOnOpen }
}

function focusName(): string {
  const el = document.activeElement
  if (!el || el === document.body) return 'the page'
  return el.getAttribute('aria-label') ?? el.tagName.toLowerCase()
}

async function run() {
  const deadline = Date.now() + 8000
  while (document.querySelectorAll('[data-select-key]').length < 2 && Date.now() < deadline) await sleep(50)
  const rows = document.querySelectorAll<HTMLElement>('[data-select-key]')
  if (rows.length < 2) return publish({ pass: false, error: 'file rows never rendered' })
  await sleep(200)
  const rootsReadsOnMount = rootsReads()
  // The top level opens by default; the nested folder is opened through its own disclosure, so
  // every depth has a box to measure.
  while (!document.querySelector('button[aria-label="raw"]') && Date.now() < deadline) await sleep(50)
  const raw = document.querySelector<HTMLButtonElement>('button[aria-label="raw"]')
  if (!raw) return publish({ pass: false, error: 'the nested folder never rendered' })
  raw.click()
  await sleep(200)

  const scroller = pane()
  if (!scroller) return publish({ pass: false, error: 'scroll pane not found' })
  const controls = scroller.previousElementSibling as HTMLElement | null
  const controlsRow = scroller.parentElement?.firstElementChild as HTMLElement | null
  if (!controlsRow || !controls) return publish({ pass: false, error: 'controls row not found' })
  const restControlsLeft = controlsRow.getBoundingClientRect().left
  // The first row of the tree itself, not the first file row, which sits one level in.
  const restRowLeft = (scroller.firstElementChild?.firstElementChild as HTMLElement | null)?.getBoundingClientRect().left ?? -1
  const overflowAtRest = documentOverflows()
  const downloadsTo = controlsGeometry()

  const topBox = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Select all'))
  if (!topBox) return publish({ pass: false, error: 'top box not found' })
  // The select-all chord (⌘A: the fake bridge reports darwin) pressed on the focused button opens
  // the column as the top box's first tick does.
  const button = document.querySelector<HTMLButtonElement>('main button[aria-label^="Downloads go to"]')
  button?.focus()
  button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, bubbles: true, cancelable: true }))
  await sleep(400)
  const focusAfterChord = focusName()

  const boxes = Array.from(scroller.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).map((i) => i.closest('label') as HTMLElement)
  const lefts = boxes.map((l) => Math.round(l.getBoundingClientRect().left * 100) / 100)
  const portLeft = scroller.getBoundingClientRect().left + scroller.clientLeft
  const ringRoom = boxes.length ? Math.min(...boxes.map((l) => l.getBoundingClientRect().left - portLeft)) : -1
  const oneX = lefts.length > 0 && Math.max(...lefts) - Math.min(...lefts) <= 0.5
  const overflowSelecting = documentOverflows()
  const atRestAligned = Math.abs(restRowLeft - restControlsLeft) <= 0.5
  const bar = barAlignment()
  const downloadsToHiddenSelecting = !controlsGeometry().found
  const split = splitGeometry()
  const offline = await actOnOfflineFolder()

  publish({
    atRestAligned, restRowLeft, restControlsLeft,
    boxes: boxes.length, boxLefts: lefts, oneX, ringRoom: Math.round(ringRoom * 100) / 100,
    overflowAtRest, overflowSelecting, ...bar, downloadsTo, downloadsToHiddenSelecting, focusAfterChord, rootsReadsOnMount, ...offline, split,
    pass: atRestAligned && boxes.length >= PATHS.length + 3 && oneX && ringRoom >= RING && !overflowAtRest && !overflowSelecting && bar.barAligned
      && downloadsTo.found && downloadsTo.between && downloadsTo.labelInName && downloadsTo.expandLeft !== null && downloadsToHiddenSelecting
      && focusAfterChord === topBox.getAttribute('aria-label')
      && rootsReadsOnMount === 0 && offline.inertWhenOffline && offline.reprobedOnClick && offline.enabledAfterReprobe && offline.reprobedOnOpen
      && split.found && split.aligned && split.joined && split.pressFlat && !split.cancelShown && split.labelInName,
    error: null,
  })
}

run()
