// Text-truncation harness (LOCAL/dev-machine only — spawns a real Electron GUI process, like the
// agent-desktop frontend suite). Mounts the REAL <PathRow>, file cards, a folder row with a file row
// inside it and a share card in deliberately narrow fields and asserts the text never escapes them.
//
// A path keeps its final segment; a name is middle-truncated so both its beginning and the part
// right before the extension stay visible, its full form is the accessible name, and hovering
// anywhere on its card (not only the name) resolves to a title carrying it. Geometry is the only honest test of fit: the text either sits inside its box or
// it does not.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import PathRow from '../../src/renderer/components/path/PathRow.js'
import FileCard from '../../src/renderer/components/cards/FileCard.js'
import FolderTree from '../../src/renderer/components/folder/FolderTree.js'
import ShareCard from '../../src/renderer/components/cards/ShareCard.js'
import { buildFileTree } from '../../src/renderer/model/file-tree.js'
import type { ShareWithRole } from '../../src/renderer/hooks/useShares.js'
import type { FileEntry } from '../../src/renderer/types/types.js'
import type { Decoration } from '../../src/renderer/types/ui.js'

const LONG_PATH = '/Users/oliver/Music/Sets/Boiler Room Carl Cox in Ibiza, Aug 15, 2013 (DJ Mix)'
const LONG_FILE = 'XXX-X002_T001_0401XI_16384x8192_25fps_40Mbps_ProRes4444_133pt2_01_part01.mov'
const SHORT_FILE = 'notes.txt'
// Dots inside a folder or share name are text, not an extension: both must still split evenly.
const LONG_FOLDER = 'Mr. Robot Season 1 Complete Collection Remastered Edition with Extras'
const LONG_SHARE = '2026.10 Client Deliverables Autumn Campaign Final Masters Approved by Legal'

interface NameResult {
  shown: string
  cardTitle: string
  accessible: string
  overflow: number
}

interface HarnessResults {
  pass: boolean
  error: string | null
  pathOverflow: number
  pathEndsWith: string
  pathEllipsised: boolean
  file: NameResult
  short: NameResult
  folder: NameResult
  nested: NameResult
  share: NameResult
  laneTitle: string
  shareActionTitle: string
  laneIntrinsicShare: number
}

declare global {
  interface Window { __results: HarnessResults }
}

const noop = () => {}
const NESTED = `${LONG_FOLDER}/${LONG_FILE}`
const folderTree = buildFileTree([
  { relPath: NESTED, size: 1024, hash: 'h', mtime: 0, status: 'synced' },
])
const looseFile = (name: string, status: FileEntry['status'] = 'remote'): FileEntry => ({
  path: '/shares/' + name,
  size: 4 * 1024 ** 3,
  hash: 'h-' + name,
  owner: { displayName: 'Oliver', publicKey: 'ownerkey' },
  localBytes: 0,
  isAvailable: true,
  status,
})
const downloading: Decoration = { bytes: 30, total: 100, speed: 5e6, avgSpeed: 5e6, eta: 643 }
const cardHandlers = {
  isOwn: false, onDownload: noop, onCancel: noop, onPause: noop, onReveal: noop, onUnshare: noop, onCancelPublish: noop,
  spaceId: 'space1', recipients: [],
}
const share: ShareWithRole = {
  id: 'share1',
  type: 'owned-folder',
  name: LONG_SHARE,
  owner: 'ownerkey',
  spaceId: 'space1',
  createdAt: 0,
  role: 'mine',
  mountStatus: 'ok',
  mirrorEnabled: true,
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ width: 520 }} className="p-4 space-y-4">
    <div data-test="path">
      <PathRow path={LONG_PATH} onAction={noop} />
    </div>
    <div data-test="file">
      <FileCard file={looseFile(LONG_FILE)} decoration={null} seeded={false} {...cardHandlers} />
    </div>
    <div data-test="lane">
      <FileCard file={looseFile(LONG_FILE, 'downloading')} decoration={downloading} seeded={false} {...cardHandlers} />
    </div>
    <div data-test="short">
      <FileCard file={looseFile(SHORT_FILE)} decoration={null} seeded={false} {...cardHandlers} />
    </div>
    <div data-test="folder">
      <FolderTree
        nodes={folderTree}
        isOwn
        manualControls={false}
        spaceId="space1"
        members={[]}
        getRecipients={() => []}
        ownerKey="owner"
        getDecoration={() => null}
        getDownloadSummary={() => null}
        isSeeded={() => false}
        onDownload={noop}
        onReveal={noop}
        onPause={noop}
        onCancel={noop}
        isExpanded={() => true}
        onToggle={noop}
      />
    </div>
    <div data-test="share">
      <ShareCard share={share} owner={null} selfProfile={null} fileCount={3} totalBytes={4096} onOpen={noop} />
    </div>
  </div>,
)

// How far the widest rendered text run escapes its field's content box, in px. <= 0 is the
// invariant; a positive number is text sitting on top of whatever comes next.
function overflowOf(field: HTMLElement): number {
  const limit = field.getBoundingClientRect().right - parseFloat(getComputedStyle(field).paddingRight)
  let worst = -Infinity
  for (const span of Array.from(field.querySelectorAll('span'))) {
    // sr-only nodes are clipped to 1px and carry the full string by design.
    if (span.className.includes('sr-only')) continue
    worst = Math.max(worst, span.getBoundingClientRect().right - limit)
  }
  return Math.round(worst * 10) / 10
}

// The last visible run — proof the ending stayed pinned rather than being ellipsised away.
function lastRun(field: HTMLElement): string {
  const spans = Array.from(field.querySelectorAll<HTMLElement>('span'))
    .filter((s) => !s.className.includes('sr-only') && s.textContent)
  return spans.at(-1)?.textContent ?? ''
}

// The card's icon tile: a spot on the card that is not the name, so a title found there is the
// card's, not the name's.
function iconOf(card: Element): HTMLElement {
  return card.querySelector<HTMLElement>('.w-12.h-12') as HTMLElement
}

function nameIn(sel: string, full: string, cardSel: string): NameResult {
  const scope = document.querySelector(`[data-test="${sel}"]`) as HTMLElement
  const host = Array.from(scope.querySelectorAll<HTMLElement>('span.block'))
    .find((el) => el.querySelector('.sr-only')?.textContent === full)
  if (!host) throw new Error(`${sel}: no name element carrying "${full}"`)
  const card = host.closest(cardSel) as HTMLElement
  const icon = iconOf(card).getBoundingClientRect()
  const hit = document.elementFromPoint(icon.x + icon.width / 2, icon.y + icon.height / 2)
  const shownEl = host.querySelector<HTMLElement>('[aria-hidden="true"]')
  return {
    shown: shownEl?.textContent ?? '',
    cardTitle: hit?.closest<HTMLElement>('[title]')?.title ?? '',
    accessible: host.querySelector('.sr-only')?.textContent ?? '',
    overflow: Math.round(((shownEl?.getBoundingClientRect().right ?? Infinity) - host.getBoundingClientRect().right) * 10) / 10,
  }
}

// Middle-truncated: an ellipsis, the beginning, and an ending at least as long as the beginning
// that holds more than the extension alone.
function middleTruncated(r: NameResult, full: string): boolean {
  const [head = '', tail = ''] = r.shown.split('…')
  const ext = /.\.[^.\s]{1,8}$/.test(full) ? full.length - full.lastIndexOf('.') : 0
  return r.shown.includes('…') && head.length > 0 && full.startsWith(head)
    && tail.length >= head.length && tail.length > ext && full.endsWith(tail)
}

// The title found where a hit lands on `el`'s centre.
function titleAt(el: Element | null): string {
  if (!el) return 'missing'
  const r = el.getBoundingClientRect()
  return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest<HTMLElement>('[title]')?.title ?? ''
}

// The lane row's name at its natural (max-content) width, as a share of the full name's rendered
// width. Flex shares a row's shortfall by that width, so it must be the whole name's (1.0): were it
// the truncated text's, each cut would cede room to the lane and invite another cut.
function laneIntrinsicShare(): number {
  const host = document.querySelector('[data-test="lane"] span[title]') as HTMLElement
  const cs = getComputedStyle(host)
  const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  host.style.width = 'max-content'
  const natural = host.getBoundingClientRect().width
  host.style.width = ''
  return Math.round((natural / ctx.measureText(LONG_FILE).width) * 100) / 100
}

const fits = (r: NameResult, full: string) => r.overflow <= 0 && r.cardTitle === full && r.accessible === full

function collect(): HarnessResults {
  const pathField = document.querySelector('[data-test="path"] .bg-surface-container-low') as HTMLElement
  const results: HarnessResults = {
    error: null,
    pathOverflow: overflowOf(pathField),
    pathEndsWith: lastRun(pathField),
    // An ellipsis is actually being painted: the flexible run's content is wider than the box
    // it is allowed to occupy. (innerText is no good here — the sr-only node carries the whole
    // path by design, so it never gets shorter.)
    pathEllipsised: (() => {
      const run = pathField.querySelector('span span') as HTMLElement
      return run.scrollWidth > run.clientWidth + 1
    })(),
    file: nameIn('file', LONG_FILE, '.group'),
    short: nameIn('short', SHORT_FILE, '.group'),
    folder: nameIn('folder', LONG_FOLDER, 'button'),
    nested: nameIn('folder', NESTED, '.group'),
    share: nameIn('share', LONG_SHARE, '.group'),
    // Controls in a card keep their own tooltip or none — never the card's file name.
    laneTitle: titleAt(document.querySelector('[data-test="lane"] [role="progressbar"]')),
    shareActionTitle: titleAt(document.querySelector('[data-test="share"] button[aria-label="Browse Files"]')),
    laneIntrinsicShare: laneIntrinsicShare(),
    pass: false,
  }
  results.pass =
    results.pathOverflow <= 0 &&
    results.pathEllipsised &&
    results.pathEndsWith.endsWith('(DJ Mix)') &&
    fits(results.file, LONG_FILE) && middleTruncated(results.file, LONG_FILE) &&
    fits(results.short, SHORT_FILE) && results.short.shown === SHORT_FILE &&
    fits(results.folder, LONG_FOLDER) && middleTruncated(results.folder, LONG_FOLDER) &&
    fits(results.nested, NESTED) && middleTruncated(results.nested, LONG_FILE) &&
    fits(results.share, LONG_SHARE) && middleTruncated(results.share, LONG_SHARE) &&
    results.laneTitle !== LONG_FILE && results.laneTitle !== 'missing' &&
    results.shareActionTitle === 'Browse Files' &&
    results.laneIntrinsicShare >= 0.98
  return results
}

const emptyName: NameResult = { shown: '', cardTitle: '', accessible: '', overflow: 0 }

// Names are fitted by measuring the real font, so results are read only once it has loaded.
document.fonts.ready
  .then(() => new Promise((r) => setTimeout(r, 300)))
  .then(collect)
  .then((results) => { window.__results = results })
  .catch((e: unknown) => {
    window.__results = {
      pass: false, error: String(e), pathOverflow: 0, pathEndsWith: '', pathEllipsised: false,
      file: emptyName, short: emptyName, folder: emptyName, nested: emptyName, share: emptyName,
      laneTitle: '', shareActionTitle: '', laneIntrinsicShare: 0,
    }
  })
