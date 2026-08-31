// Real-Chromium harness for the full-bleed Drop-to-Share overlay. Mounts the REAL
// <SpaceView> (the only place that can't be exercised by agent-desktop, since it
// drives the AX tree and can't synthesize a native file-drag), dispatches synthetic
// DragEvents, and asserts the crossfade + geometry + copy in real layout.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import i18n from './../../src/renderer/i18n.js'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from './../../src/renderer/keyboard/KeyboardProvider.js'
import SpaceView from './../../src/renderer/screens/SpaceView.js'

interface FakeDriver {
  SPACE_ID: string
}

interface HarnessResults {
  pass: boolean
  error: string | null
  idleOpacity: number
  idleHidden: boolean
  shareReachable: boolean
  textIgnored: boolean
  filesActiveOpacity: number
  smallFaded: number
  filesSub: string
  folderSub: string
  afterLeaveOpacity: number
  geomOk: boolean
}

declare global {
  interface Window {
    __fake: FakeDriver
    __results: HarnessResults
  }
}

const f = window.__fake

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="min-h-screen bg-surface">
    <main className="pt-[calc(5rem+var(--banner-h,0px))]">
      <ToastProvider>
        <KeyboardProvider currentScreen="space-view" selectedSpaceId={f.SPACE_ID}>
          <SpaceView spaceId={f.SPACE_ID} onBack={() => {}} onManageStorage={() => {}} />
        </KeyboardProvider>
      </ToastProvider>
    </main>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function fireDrag(target: Element, type: string, files: File[]): void {
  const dt = new DataTransfer()
  for (const file of files) dt.items.add(file)
  target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
}

function fireTextDrag(target: Element, type: string): void {
  const dt = new DataTransfer()
  dt.setData('text/plain', 'hello')
  target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
}

function opacity(el: Element): number {
  return Number(getComputedStyle(el).opacity)
}

function publishError(error: string): void {
  window.__results = {
    pass: false, error,
    idleOpacity: 0, idleHidden: false, shareReachable: false, textIgnored: false,
    filesActiveOpacity: 0, smallFaded: 1, filesSub: '', folderSub: '',
    afterLeaveOpacity: 0, geomOk: false,
  }
}

async function run(): Promise<void> {
  const deadline = Date.now() + 8000
  let overlay: HTMLElement | null = null
  while (!overlay && Date.now() < deadline) {
    await sleep(50)
    overlay = document.querySelector<HTMLElement>('.border-dashed.inset-x-0')
  }
  if (!overlay) return publishError('overlay never mounted')

  const grid = overlay.parentElement
  const smallZone = document.querySelector<HTMLElement>('[role="group"].border-dashed')
  if (!grid || !smallZone) return publishError('content grid or resting drop zone not found')
  const shareBtn = smallZone.querySelector('button')

  const idleOpacity = opacity(overlay)
  const idleHidden = overlay.getAttribute('aria-hidden') === 'true'
  const shareReachable = !!shareBtn && (shareBtn.textContent || '').includes(i18n.t('dropZone.browse'))

  fireTextDrag(grid, 'dragenter')
  fireTextDrag(grid, 'dragover')
  await sleep(120)
  const textIgnored = opacity(overlay) < 0.05

  fireDrag(grid, 'dragenter', [new File(['a'], 'a.txt', { type: 'text/plain' })])
  fireDrag(grid, 'dragover', ['a', 'b', 'c'].map((n) => new File([n], `${n}.txt`, { type: 'text/plain' })))
  await sleep(320)
  const filesActiveOpacity = opacity(overlay)
  const filesSub = overlay.querySelector('p')?.textContent ?? ''
  const smallFaded = opacity(smallZone)

  const o = overlay.getBoundingClientRect()
  const g = grid.getBoundingClientRect()
  const z = smallZone.getBoundingClientRect()
  const geomOk =
    Math.abs(o.left - g.left) < 2 &&
    Math.abs(o.right - g.right) < 2 &&
    // The overlay intentionally insets bottom-8 from the grid — the consistent 32px page
    // gutter introduced in #276 — so its bottom sits one gutter above the grid's bottom.
    Math.abs((g.bottom - o.bottom) - 32) < 2 &&
    Math.abs(o.top - z.top) < 4

  fireDrag(grid, 'dragover', [new File([], 'Photos')])
  await sleep(120)
  const folderSub = overlay.querySelector('p')?.textContent ?? ''

  const dropFile = [new File(['a'], 'a.txt', { type: 'text/plain' })]
  fireDrag(grid, 'dragleave', dropFile)
  fireDrag(grid, 'drop', dropFile)
  await sleep(320)
  const afterLeaveOpacity = opacity(overlay)

  window.__results = {
    pass:
      idleOpacity < 0.05 && idleHidden && shareReachable && textIgnored &&
      filesActiveOpacity > 0.95 && smallFaded < 0.05 &&
      filesSub === i18n.t('dropZone.releaseFiles', { count: 3 }) &&
      geomOk &&
      folderSub === i18n.t('dropZone.releaseFolderUnnamed') &&
      afterLeaveOpacity < 0.05,
    error: null,
    idleOpacity, idleHidden, shareReachable, textIgnored,
    filesActiveOpacity, smallFaded, filesSub, folderSub,
    afterLeaveOpacity, geomOk,
  }
}

run()
