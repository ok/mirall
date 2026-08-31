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
const callbacks = {
  spaceId: 'space1',
  members: [],
  getDownloadSummary: () => null,
  onDownload: noop,
  onReveal: noop,
  onPause: noop,
  onCancel: noop,
  onDiscardPartial: noop,
  isExpanded: () => true,
  onToggle: noop,
}

function entry(relPath: string, status: ShareFileEntry['status'], progress = false): ShareFileEntry {
  return {
    relPath,
    size: 2 * 1024 ** 3,
    hash: status === 'preparing' || status === 'publishing' ? '' : 'hash-' + relPath,
    mtime: 0,
    status,
    ...(progress ? { progress: { bytes: 30, total: 100, speed: 0, eta: 11 } } : {}),
  }
}

const ownTree: FileTreeNode[] = buildFileTree([
  entry('movies/american-hustle.mp4', 'publishing', true),
  entry('movies/asterix.mkv', 'synced'),
])
const memberTree: FileTreeNode[] = buildFileTree([
  entry('movies/american-hustle.mp4', 'preparing', true),
  entry('movies/asterix.mkv', 'remote'),
])
const mixedTree: FileTreeNode[] = buildFileTree([
  entry('movies/american-hustle.mp4', 'preparing', true),
  entry('movies/asterix.mkv', 'downloading', true),
])

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8 space-y-4" style={{ width: 1100 }}>
    <div id="own-host" className="space-y-2">
      <FolderTree {...callbacks} nodes={ownTree} isOwn manualControls={false} />
    </div>
    <div id="member-host" className="space-y-2">
      <FolderTree {...callbacks} nodes={memberTree} isOwn={false} manualControls />
    </div>
    <div id="mixed-host" className="space-y-2">
      <FolderTree {...callbacks} nodes={mixedTree} isOwn={false} manualControls />
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
