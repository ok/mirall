// Real-Chromium harness for the indexing labels in FolderView. Mounts the REAL
// <FolderTree> three times — an owner's folder mid-index, a member's folder waiting on that
// index, and a member's folder with a real download alongside — and reads back what each one
// actually says. Indexing is not a transfer: neither side may be told anything is downloading,
// and the bar over an indexing row must be named for the indexing it measures.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import FolderTree from './../../src/renderer/components/widgets/FolderTree.js'
import { buildFileTree } from './../../src/renderer/fileTree.js'
import type { Decoration, DecorationPhase } from './../../src/renderer/hooks/useDecorations.js'
import type { ShareFileEntry, FileTreeNode } from './../../src/renderer/types.js'

interface HarnessResults {
  pass: boolean
  error: string | null
  ownFolderText: string
  ownRowText: string
  ownBarLabel: string
  memberFolderText: string
  memberRowText: string
  memberBarLabel: string
  mixedFolderText: string
  downloadBarLabel: string
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const noop = () => {}
const base = {
  spaceId: 'space1',
  members: [],
  getDownloadSummary: () => null,
  isSeeded: () => false,
  onDownload: noop,
  onReveal: noop,
  onPause: noop,
  onCancel: noop,
  onDiscardPartial: noop,
  isExpanded: () => true,
  onToggle: noop,
}

function entry(relPath: string, status: ShareFileEntry['status']): ShareFileEntry {
  return {
    relPath,
    size: 2 * 1024 ** 3,
    hash: status === 'preparing' || status === 'publishing' ? '' : 'hash-' + relPath,
    mtime: 0,
    status,
  }
}

const HUSTLE = 'movies/american-hustle.mp4'
const ASTERIX = 'movies/asterix.mkv'

// Progress is a per-row PROP now, not a field on the entry, so each tree brings its own lookup —
// which is also the only way to say what these three cases are about: the SAME path is
// `publishing` in the owner's tree and `preparing` in the member's, and rowView.js paints a frame
// only onto a row whose status matches its phase.
const frame = (phase?: DecorationPhase): Decoration =>
  ({ bytes: 30, total: 100, speed: 0, avgSpeed: 0, eta: 11, phase })
const lookup = (byPath: Record<string, Decoration>) => (relPath: string) => byPath[relPath] ?? null

const ownCallbacks = { ...base, getDecoration: lookup({ [HUSTLE]: frame('publishing') }) }
const memberCallbacks = { ...base, getDecoration: lookup({ [HUSTLE]: frame('preparing') }) }
const mixedCallbacks = { ...base, getDecoration: lookup({ [HUSTLE]: frame('preparing'), [ASTERIX]: frame() }) }

const ownTree: FileTreeNode[] = buildFileTree([
  entry(HUSTLE, 'publishing'),
  entry(ASTERIX, 'synced'),
])
const memberTree: FileTreeNode[] = buildFileTree([
  entry(HUSTLE, 'preparing'),
  entry(ASTERIX, 'remote'),
])
const mixedTree: FileTreeNode[] = buildFileTree([
  entry(HUSTLE, 'preparing'),
  entry(ASTERIX, 'downloading'),
])

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8 space-y-4" style={{ width: 1100 }}>
    <div id="own-host" className="space-y-2">
      <FolderTree {...ownCallbacks} nodes={ownTree} isOwn manualControls={false} />
    </div>
    <div id="member-host" className="space-y-2">
      <FolderTree {...memberCallbacks} nodes={memberTree} isOwn={false} manualControls />
    </div>
    <div id="mixed-host" className="space-y-2">
      <FolderTree {...mixedCallbacks} nodes={mixedTree} isOwn={false} manualControls />
    </div>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const textOf = (sel: string) => document.querySelector(sel)?.textContent ?? ''
const barLabel = (sel: string) => document.querySelector(sel)?.getAttribute('aria-label') ?? ''

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  // i18n resolves asynchronously; before it lands the labels render as raw keys.
  while (Date.now() < deadline && !/\d+ adding/i.test(textOf('#own-host button'))) await sleep(50)

  const ownFolderText = textOf('#own-host button')
  const ownRowText = textOf('#own-host [role="group"]')
  const ownBarLabel = barLabel('#own-host [role="progressbar"]')
  const memberFolderText = textOf('#member-host button')
  const memberRowText = textOf('#member-host [role="group"]')
  const memberBarLabel = barLabel('#member-host [role="progressbar"]')
  const mixedFolderText = textOf('#mixed-host button')
  const rows = document.querySelectorAll('#mixed-host [role="group"] > div')
  const downloadBarLabel = rows[1]?.querySelector('[role="progressbar"]')?.getAttribute('aria-label') ?? ''

  const pass =
    /1 adding/i.test(ownFolderText) && !/downloading/i.test(ownFolderText) &&
    ownRowText.includes('Adding') && !/downloading/i.test(ownRowText) &&
    ownBarLabel === 'Indexing progress' &&
    /1 preparing/i.test(memberFolderText) && !/downloading/i.test(memberFolderText) &&
    memberRowText.includes('Preparing') && !/downloading/i.test(memberRowText) &&
    memberBarLabel === 'Indexing progress' &&
    /1 downloading/i.test(mixedFolderText) && /1 preparing/i.test(mixedFolderText) &&
    downloadBarLabel === 'Download progress'

  window.__results = {
    pass,
    error: null,
    ownFolderText,
    ownRowText,
    ownBarLabel,
    memberFolderText,
    memberRowText,
    memberBarLabel,
    mixedFolderText,
    downloadBarLabel,
  }
}

run().catch((err: Error) => {
  window.__results = {
    pass: false,
    error: err.message,
    ownFolderText: '', ownRowText: '', ownBarLabel: '',
    memberFolderText: '', memberRowText: '', memberBarLabel: '',
    mixedFolderText: '', downloadBarLabel: '',
  }
})
