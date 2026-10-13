// Real-Chromium layout harness for the file row's error state and the toast width.
// Mounts REAL <FileRow>s — three loose (one at rest, two failed: short + long error)
// and two in a folder (one at rest, one failed) — and asserts a failed row keeps
// EXACTLY its kind's at-rest row height (the error text must live inside the
// existing meta line, not add a third text row). Also mounts the
// real <ToastContainer> and asserts a long message grows the toast to its 720px
// cap while a short one stays at content width.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/renderer/platform/i18n.js'
import FileRow from '../../src/renderer/components/cards/FileRow.js'
import ToastContainer from '../../src/renderer/components/toast/ToastContainer.js'
import type { FileEntry, ShareFileRow } from '../../src/renderer/types/types.js'
import type { ToastItem } from '../../src/renderer/components/toast/types.js'

interface HarnessResults {
  pass: boolean
  error: string | null
  baselineHeight: number
  errorHeight: number
  errorLongHeight: number
  shareBaselineHeight: number
  shareErrorHeight: number
  shareAlertText: string
  alertVisible: boolean
  alertInsideCard: boolean
  alertText: string
  toastShortWidth: number
  toastLongWidth: number
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const LONG_NAME = 'SHORT-XXX-X002_T001_0401XI_16384x8192_25fps_409pt3_133pt2_01.mov'

function fileEntry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: '/shares/' + LONG_NAME,
    size: 629.7 * 1024 ** 3,
    hash: 'hash1',
    owner: { displayName: 'Oliver', publicKey: 'ownerkey' },
    mtime: 0,
    localPath: null,
    status: 'remote',
    ...overrides,
  }
}

const noop = () => {}
const cardHandlers = {
  isOwn: false,
  onDownload: noop,
  onCancel: noop,
  onPause: noop,
  onReveal: noop,
  onUnshare: noop,
  onCancelPublish: noop,
  spaceId: 'space1',
  recipients: [],
  members: [],
  downloadSummary: null,
}

function shareFile(overrides: Partial<ShareFileRow>): ShareFileRow {
  return { relPath: 'clips/' + LONG_NAME, size: 629.7 * 1024 ** 3, hash: 'hash1', mtime: 0, localPath: null, status: 'remote', ...overrides }
}
const shareHandlers = {
  isOwn: false, manualControls: true, ownerKey: 'ownerkey', onDownload: noop, onReveal: noop, onCancel: noop, onPause: noop,
  spaceId: 'space1', recipients: [], members: [], downloadSummary: null, displayName: LONG_NAME,
}

const toastItems: ToastItem[] = [
  { id: 'short', seq: 1, variant: 'error', message: 'Disk full', duration: 0 },
  {
    id: 'long',
    seq: 2,
    variant: 'error',
    message: `Not enough disk space for “${LONG_NAME}” — free up space, then retry the download`,
    duration: 0,
  },
]

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8">
    <div id="cards-host" className="max-w-3xl space-y-2">
      <FileRow kind="loose" file={fileEntry({})} decoration={null} seeded={false} {...cardHandlers} />
      <FileRow
        kind="loose" file={fileEntry({ status: 'error', errorCode: 'TRANSFER_DISK_FULL', transferId: 't1' })}
        decoration={null} seeded={false} {...cardHandlers}
      />
      <FileRow
        kind="loose" file={fileEntry({ status: 'error', errorCode: 'TRANSFER_REMOVED', sharedByCount: 2 })}
        decoration={null} seeded={false} {...cardHandlers}
      />
      <FileRow kind="share" file={shareFile({})} decoration={null} seeded={false} {...shareHandlers} />
      <FileRow
        kind="share" file={shareFile({ status: 'error', errorCode: 'TRANSFER_DISK_FULL', transferId: 't2' })}
        decoration={null} seeded={false} {...shareHandlers}
      />
    </div>
    <ToastContainer items={toastItems} onDismiss={noop} onPause={noop} onResume={noop} />
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publishError(error: string): void {
  window.__results = {
    pass: false,
    error,
    baselineHeight: -1,
    errorHeight: -1,
    errorLongHeight: -1,
    shareBaselineHeight: -1,
    shareErrorHeight: -1,
    shareAlertText: '',
    alertVisible: false,
    alertInsideCard: false,
    alertText: '',
    toastShortWidth: -1,
    toastLongWidth: -1,
  }
}

function rectInside(inner: DOMRect, outer: DOMRect): boolean {
  return (
    inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5 &&
    inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
  )
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  let cards: Element[] = []
  let toasts: Element[] = []
  while ((cards.length < 5 || toasts.length < 2) && Date.now() < deadline) {
    await sleep(50)
    cards = Array.from(document.querySelectorAll('#cards-host > div'))
    toasts = Array.from(document.querySelectorAll('[role="region"] > div'))
  }
  if (cards.length < 5) return publishError('expected 5 file rows, got ' + cards.length)
  if (toasts.length < 2) return publishError('expected 2 toasts, got ' + toasts.length)
  await document.fonts.ready
  await sleep(250) // let the toast enter transition settle before measuring

  const [baseline, errorCard, errorLongCard, shareBaseline, shareErrorCard] = cards
  const baselineHeight = baseline.getBoundingClientRect().height
  const errorHeight = errorCard.getBoundingClientRect().height
  const errorLongHeight = errorLongCard.getBoundingClientRect().height
  const shareBaselineHeight = shareBaseline.getBoundingClientRect().height
  const shareErrorHeight = shareErrorCard.getBoundingClientRect().height

  // The failed rows must not grow: the error text belongs inside the existing
  // meta line, so a failed card is pixel-identical in height to a resting one.
  const sameHeight =
    Math.abs(errorHeight - baselineHeight) < 1.5 &&
    Math.abs(errorLongHeight - baselineHeight) < 1.5 &&
    Math.abs(shareErrorHeight - shareBaselineHeight) < 1.5

  // …but the error must still be shown: visible, announced, inside the card.
  const alertEl = errorCard.querySelector('[role="alert"]')
  const alertRect = alertEl?.getBoundingClientRect() ?? null
  const alertVisible = !!alertRect && alertRect.width > 0 && alertRect.height > 0
  const alertInsideCard = !!alertRect && rectInside(alertRect, errorCard.getBoundingClientRect())
  const alertText = alertEl?.textContent?.trim() ?? ''
  const shareAlertText = shareErrorCard.querySelector('[role="alert"]')?.textContent?.trim() ?? ''
  const alertTextOk = alertText.includes(i18n.t('errors:transferDiskFull')) && shareAlertText.includes(i18n.t('errors:transferDiskFull'))

  // Toast width: short messages hug their content; long ones cap at 720px.
  const toastShortWidth = toasts[0].getBoundingClientRect().width
  const toastLongWidth = toasts[1].getBoundingClientRect().width
  const shortOk = toastShortWidth >= 280 - 1.5 && toastShortWidth < 720
  const longOk = Math.abs(toastLongWidth - 720) < 1.5

  window.__results = {
    pass: sameHeight && alertVisible && alertInsideCard && alertTextOk && shortOk && longOk,
    error: null,
    baselineHeight,
    errorHeight,
    errorLongHeight,
    shareBaselineHeight,
    shareErrorHeight,
    shareAlertText,
    alertVisible,
    alertInsideCard,
    alertText,
    toastShortWidth,
    toastLongWidth,
  }
}

run()
