// Selection-column geometry on the space screen (LOCAL/dev-machine only — spawns a real Electron
// GUI process). Mounts the REAL <SpaceScreen> with folder cards and loose files, opens the column
// through the real top box, and asserts: every box sits at one x; the sticky "Files Shared"
// header still pins flush on the scrollport while the rows sit in the gutter; the document never
// scrolls. Another member's files are listed, so at rest the controls row carries "Downloads to"
// right of the filter, its name containing its visible label in both of its states (the space's
// folder fine, and on a drive that is not connected); while selecting it is gone, and the strip's
// split Download button's two halves share Done's height and baseline, with no Cancel beside them.
import './harness-bootstrap.js'
import { controlsGeometry, splitGeometry, type ControlsGeometry, type SplitGeometry } from './download-to-geometry.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from '../../src/renderer/keyboard/KeyboardProvider.js'
import SpaceScreen from '../../src/renderer/screens/SpaceScreen.js'
import type { FileEntry, Share } from '../../src/renderer/types/types.js'

interface Results {
  boxes: number
  boxLefts: number[]
  oneX: boolean
  foldersHidden: boolean
  headerGap: number
  headerPinned: boolean
  overflow: boolean
  pass: boolean
  barLeft: number
  filterLeft: number
  barAligned: boolean
  downloadsTo: ControlsGeometry | null
  /** The same button with the space's folder reported not connected. */
  downloadsToOffline: ControlsGeometry | null
  downloadsToHiddenSelecting: boolean
  split: SplitGeometry | null
  error: string | null
}

declare global {
  interface Window {
    __fake: { SPACE_ID: string; OWNER_PK: string; SELF_PK: string }
    __fakeEmit: (frame: { type: string; unavailable: string[] }) => void
    __HARNESS_CFG?: { shares?: Share[]; files?: FileEntry[] }
    __results: Results
  }
}

const { SPACE_ID, OWNER_PK, SELF_PK } = window.__fake

const shares: Share[] = ['Brand Assets', 'Client Handover', 'Site Survey'].map((name, i) => ({
  id: `share-${i}`, type: 'owned-folder', name, owner: i === 1 ? OWNER_PK : SELF_PK, spaceId: SPACE_ID, createdAt: 0,
}))
const NAMES = ['Brief-v3.pdf', 'Budget-2026.xlsx', 'Kickoff.mp4', 'Meeting-notes.md', 'Moodboard.png', 'Site-photos.zip', 'Rack-Layout.pdf', 'IMG_1995.pxd', 'set-notes.txt', 'stage-plot.png', 'rider-2026.docx', 'mixdown-master.wav']
const files: FileEntry[] = NAMES.map((name, i) => ({
  path: '/' + name,
  size: 8_200_000 + i,
  hash: String(i % 10).repeat(64),
  owner: i % 2 === 0 ? { displayName: 'Dana', publicKey: OWNER_PK } : { displayName: 'You', publicKey: SELF_PK },
  mtime: 0,
  localPath: i % 2 === 0 ? null : '/Users/you/' + name,
  status: i % 2 === 0 ? 'remote' : 'synced',
}))
window.__HARNESS_CFG = { shares, files }

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="min-h-screen bg-surface">
    <main className="pt-[calc(5rem+var(--banner-h,0px))]">
      <ToastProvider>
        <KeyboardProvider currentScreen="space-view" selectedSpaceId={SPACE_ID}>
          <SpaceScreen spaceId={SPACE_ID} pendingAction={null} onActionConsumed={() => {}} onBack={() => {}} onManageStorage={() => {}} />
        </KeyboardProvider>
      </ToastProvider>
    </main>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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
  window.__results = { boxes: 0, boxLefts: [], oneX: false, foldersHidden: false, headerGap: -1, headerPinned: false, overflow: false, barLeft: -1, filterLeft: -2, barAligned: false, downloadsTo: null, downloadsToOffline: null, downloadsToHiddenSelecting: false, split: null, ...partial }
}

async function run() {
  const deadline = Date.now() + 8000
  while (document.querySelectorAll('[data-select-key]').length < NAMES.length && Date.now() < deadline) await sleep(50)
  if (document.querySelectorAll('[data-select-key]').length < NAMES.length) return publish({ pass: false, error: 'file rows never rendered' })
  const scroller = pane()
  if (!scroller) return publish({ pass: false, error: 'scroll pane not found' })

  const downloadsTo = controlsGeometry()
  window.__fakeEmit({ type: 'event:download-roots-status', unavailable: ['/Users/you/Downloads'] })
  await sleep(150)
  const downloadsToOffline = controlsGeometry()
  window.__fakeEmit({ type: 'event:download-roots-status', unavailable: [] })
  await sleep(150)
  const topBox = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Select all'))
  if (!topBox) return publish({ pass: false, error: 'top box not found' })
  topBox.click()
  await sleep(400)

  const boxes = Array.from(scroller.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).map((i) => i.closest('label') as HTMLElement)
  const lefts = boxes.map((l) => Math.round(l.getBoundingClientRect().left * 100) / 100)
  const oneX = lefts.length > 0 && Math.max(...lefts) - Math.min(...lefts) <= 0.5
  const foldersHidden = !Array.from(document.querySelectorAll('h2')).some((h) => h.textContent === 'Folders Shared')
  const bar = barAlignment()
  const downloadsToHiddenSelecting = !controlsGeometry().found
  const split = splitGeometry()

  scroller.scrollTop = 200
  await sleep(150)
  const header = Array.from(scroller.querySelectorAll<HTMLElement>('div')).find((el) => getComputedStyle(el).position === 'sticky')
  const portTop = scroller.getBoundingClientRect().top + scroller.clientTop
  const headerGap = header ? Math.round((header.getBoundingClientRect().top - portTop) * 100) / 100 : -1
  const headerPinned = header !== undefined && Math.abs(headerGap) <= 0.5
  const overflow = documentOverflows()

  publish({
    boxes: boxes.length, boxLefts: lefts, oneX, foldersHidden, headerGap, headerPinned, overflow, ...bar, downloadsTo, downloadsToOffline, downloadsToHiddenSelecting, split,
    pass: boxes.length === NAMES.length && oneX && foldersHidden && headerPinned && !overflow && bar.barAligned
      && downloadsTo.found && downloadsTo.between && downloadsTo.labelInName && downloadsToHiddenSelecting
      && downloadsToOffline.found && downloadsToOffline.visible.includes('not connected') && downloadsToOffline.labelInName
      && split.found && split.aligned && split.joined && split.pressFlat && !split.cancelShown && split.labelInName,
    error: null,
  })
}

run()
