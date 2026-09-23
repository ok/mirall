// Real-Chromium harness for the owner's row while members wait on its hash. Mounts the REAL
// <FileCard> — publishing, with three members waiting — at a wide, a medium and a narrow row, and
// asserts the waiting cluster yields width before the hash bar does: nothing overflows the row,
// the indexing bar keeps its width, the "N waiting" toggle stays inside the card, and only a narrow
// row sheds the avatar stack.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import FileCard from './../../src/renderer/components/cards/FileCard.js'
import type { FileEntry, PeerDownloadSummary, SpaceMember } from '../../src/renderer/types/types.js'
import type { Decoration } from '../../src/renderer/types/ui.js'

interface RowMetrics {
  overflow: boolean
  barWidth: number
  toggleVisible: boolean
  toggleInside: boolean
  stackVisible: boolean
}

interface HarnessResults {
  pass: boolean
  error: string | null
  rows: Record<string, RowMetrics>
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const WIDTHS = [{ id: 'wide', w: 760 }, { id: 'medium', w: 520 }, { id: 'narrow', w: 400 }]
const BAR_MIN = 120

const member = (n: number, name: string): SpaceMember => ({ publicKey: 'k' + n, displayName: name, online: true })
const members = [member(1, 'Alexandra Featherstonehaugh'), member(2, 'Bob'), member(3, 'Carol')]
const file: FileEntry = {
  path: '/a-rather-long-archive-name-that-must-truncate.bin',
  size: 32 * 1024 ** 3,
  hash: '',
  owner: { displayName: 'Oliver', publicKey: 'ownerkey' },
  localBytes: 0,
  isAvailable: true,
  status: 'publishing',
}
const decoration: Decoration = { bytes: 30, total: 100, speed: 0, avgSpeed: 0, eta: 40, phase: 'publishing' }
const summary: PeerDownloadSummary = {
  spaceId: 's1', path: file.path, personKeys: [], pausedKeys: [], waitingKeys: ['k1', 'k2', 'k3'], bytes: 0, total: 0, avgSpeed: 0,
}
const noop = () => {}
const handlers = { onDownload: noop, onCancel: noop, onPause: noop, onReveal: noop, onUnshare: noop, onDiscardPartial: noop, onCancelPublish: noop }

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8 space-y-4">
    {WIDTHS.map(({ id, w }) => (
      <div key={id} data-row={id} style={{ width: w }}>
        <FileCard file={file} decoration={decoration} seeded={false} members={members} downloadSummary={summary} {...handlers} />
      </div>
    ))}
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const visible = (el: Element | null) => {
  if (!(el instanceof HTMLElement)) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function measure(id: string): RowMetrics | null {
  const host = document.querySelector(`[data-row="${id}"]`)
  const card = host?.firstElementChild
  const line = card?.firstElementChild
  const bar = host?.querySelector('[role="progressbar"]')
  const toggle = host?.querySelector('button[aria-expanded]')
  if (!(card instanceof HTMLElement) || !(line instanceof HTMLElement) || !bar || !toggle) return null
  const c = card.getBoundingClientRect()
  const tr = toggle.getBoundingClientRect()
  return {
    overflow: line.scrollWidth > line.clientWidth + 1,
    barWidth: bar.getBoundingClientRect().width,
    toggleVisible: visible(toggle),
    toggleInside: tr.left >= c.left - 0.5 && tr.right <= c.right + 0.5,
    stackVisible: visible(host?.querySelector('[role="img"][aria-label^="Waiting for this file"]') ?? null),
  }
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  while (document.querySelectorAll('button[aria-expanded]').length < WIDTHS.length && Date.now() < deadline) await sleep(50)
  await document.fonts.ready
  await sleep(100)
  const rows: Record<string, RowMetrics> = {}
  for (const { id } of WIDTHS) {
    const m = measure(id)
    if (!m) { window.__results = { pass: false, error: 'row ' + id + ' did not render its waiting toggle', rows }; return }
    rows[id] = m
  }
  const pass = Object.values(rows).every((m) => !m.overflow && m.barWidth >= BAR_MIN && m.toggleVisible && m.toggleInside)
    && rows.wide.stackVisible && rows.medium.stackVisible && !rows.narrow.stackVisible
  window.__results = { pass, error: null, rows }
}

run()
