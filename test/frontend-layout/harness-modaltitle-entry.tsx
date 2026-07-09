// REGRESSION harness for the confirm-modal title. A long file name interpolated
// into `Remove “{{name}}”?` must (1) never overflow/clip the fixed-width panel,
// (2) never squash the close button, (3) middle-truncate keeping BOTH ends and
// the extension (`XXX-X002_…final.mov`, not just `.mov`), (4) stay within two
// lines, while (5) a short name renders in full and (6) the full name still
// reaches assistive tech. Mounts the REAL <RemoveFileModal> twice.
import { createRoot } from 'react-dom/client'
import RemoveFileModal from './../../src/renderer/components/modals/RemoveFileModal.js'

const LONG_NAME = 'XXX-X002_T001_0401XI_16384x8192_25fps_409pt3_133pt2_S001_take_01_final.mov'
const SHORT_NAME = 'notes.txt'

interface HarnessResults {
  pass: boolean
  error: string | null
  longPanelWidth: number
  longPanelScrollWidth: number
  longTitleInside: boolean
  longNameAccessible: boolean
  longCloseWidth: number
  longCloseHeight: number
  longFitName: string
  longTitleHeight: number
  longLineHeight: number
  shortPanelScrollWidth: number
  shortPanelWidth: number
  shortFitName: string
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const noop = () => {}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface">
    <RemoveFileModal isOpen filePath={'/shares/' + LONG_NAME} onClose={noop} onRemove={noop} />
    <RemoveFileModal isOpen filePath={'/shares/' + SHORT_NAME} onClose={noop} onRemove={noop} />
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publishError(error: string): void {
  window.__results = {
    pass: false,
    error,
    longPanelWidth: -1,
    longPanelScrollWidth: -1,
    longTitleInside: false,
    longNameAccessible: false,
    longCloseWidth: -1,
    longCloseHeight: -1,
    longFitName: '',
    longTitleHeight: -1,
    longLineHeight: -1,
    shortPanelScrollWidth: -1,
    shortPanelWidth: -1,
    shortFitName: '',
  }
}

const fitNameOf = (title: Element): string =>
  (title.querySelector('[data-fit-name]')?.textContent ?? '')

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  let dialogs: HTMLElement[] = []
  while (dialogs.length < 2 && Date.now() < deadline) {
    await sleep(50)
    dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
  }
  if (dialogs.length < 2) return publishError('expected 2 dialogs, got ' + dialogs.length)
  await document.fonts.ready
  await sleep(200)

  const longPanel = dialogs.find((d) => (d.textContent ?? '').includes(LONG_NAME))
  const shortPanel = dialogs.find((d) => (d.textContent ?? '').includes(SHORT_NAME))
  if (!longPanel || !shortPanel) return publishError('could not locate both modal panels by name')

  const longTitle = longPanel.querySelector('h1')
  if (!longTitle) return publishError('long modal has no <h1> title')

  // The panel's overflow-hidden must not clip the title.
  const longPanelWidth = longPanel.clientWidth
  const longPanelScrollWidth = longPanel.scrollWidth
  const titleRect = longTitle.getBoundingClientRect()
  const panelRect = longPanel.getBoundingClientRect()
  const longTitleInside = titleRect.right <= panelRect.right + 0.5 && titleRect.left >= panelRect.left - 0.5

  // The full name must still reach assistive tech via the sr-only span.
  const longNameAccessible = (longTitle.textContent ?? '').includes(LONG_NAME)

  // The close button keeps its full 40×40 square hit target (was squashed).
  const closeBtn = Array.from(longPanel.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => !!b.getAttribute('aria-label') && !(b.textContent ?? '').trim(),
  )
  if (!closeBtn) return publishError('could not find the header close button')
  const closeRect = closeBtn.getBoundingClientRect()

  // Middle truncation keeps both ends + the extension; the title stays ≤ 2 lines.
  const longFitName = fitNameOf(longTitle)
  const longLineHeight = parseFloat(getComputedStyle(longTitle).lineHeight) || 32
  const longTitleHeight = titleRect.height

  const shortFitName = fitNameOf(shortPanel.querySelector('h1') as Element)

  window.__results = {
    pass:
      longPanelScrollWidth <= longPanelWidth + 1 &&
      longTitleInside &&
      longNameAccessible &&
      closeRect.width >= 38 &&
      Math.abs(closeRect.width - closeRect.height) <= 1 &&
      longFitName.includes('…') &&
      longFitName.endsWith('.mov') &&
      longTitleHeight <= longLineHeight * 2 + 4 &&
      shortPanel.scrollWidth <= shortPanel.clientWidth + 1 &&
      shortFitName === SHORT_NAME &&
      !shortFitName.includes('…'),
    error: null,
    longPanelWidth,
    longPanelScrollWidth,
    longTitleInside,
    longNameAccessible,
    longCloseWidth: closeRect.width,
    longCloseHeight: closeRect.height,
    longFitName,
    longTitleHeight,
    longLineHeight,
    shortPanelScrollWidth: shortPanel.scrollWidth,
    shortPanelWidth: shortPanel.clientWidth,
    shortFitName,
  }
}

run()
