// Real-Chromium harness for who-has-the-file on the owner's resting row. Mounts the REAL <FileCard>
// and the REAL <ShareFileRow> (a folder row, with its leading gutter) at four widths, two of three
// members holding the file, and asserts the cluster sheds before the file name does: nothing
// overflows, the toggle never wraps, the faces show only on a wide row, the sentence gives way to
// "2/3" on a narrow one, and the name keeps a readable width. A further row opens its list and then
// starts publishing a new version, which takes the lane: the list must close with its toggle.
import './harness-bootstrap.js'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import FileCard from '../../src/renderer/components/cards/FileCard.js'
import ShareFileRow from '../../src/renderer/components/cards/ShareFileRow.js'
import type { FileEntry, FileRecipient, ShareFileEntry, ShareFileStatus, SpaceMember } from '../../src/renderer/types/types.js'

interface RowMetrics {
  overflow: boolean
  toggleHeight: number
  toggleInside: boolean
  facesVisible: boolean
  fullVisible: boolean
  shortVisible: boolean
  nameWidth: number
}

interface HarnessResults {
  pass: boolean
  error: string | null
  rows: Record<string, RowMetrics>
  orphan?: { opened: boolean; orphaned: boolean }
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const WIDTHS = [{ id: 'wide', w: 880, faces: true, full: true }, { id: 'medium', w: 620, faces: false, full: true },
  { id: 'narrow', w: 480, faces: false, full: false }, { id: 'tight', w: 400, faces: false, full: false }]
const KINDS = ['loose', 'folder'] as const
const NAME_MIN = 90
const TOGGLE_MAX_HEIGHT = 26

const OWNER = 'ownerkey'
const HASH = 'h'.repeat(64)
const member = (key: string, name: string): SpaceMember => ({ publicKey: key, displayName: name, online: true })
const members = [member(OWNER, 'Oliver'), member('k1', 'Alexandra Featherstonehaugh'), member('k2', 'Bob'), member('k3', 'Carol')]
const NAME = 'GitHubDesktop-x64-3.5.0-arm64.zip'
const loose: FileEntry = {
  path: '/' + NAME, size: 181.7 * 1024 ** 2, hash: HASH, owner: { displayName: 'Oliver', publicKey: OWNER },
  localBytes: 0, isAvailable: true, status: 'mine',
}
const folderFile: ShareFileEntry = { relPath: NAME, size: 181.7 * 1024 ** 2, hash: HASH, mtime: 0, status: 'synced' }
const received = (path: string, shareId: string): FileRecipient[] => ['k1', 'k2'].map((k, i) => ({ shareId, path, personKey: k, contentHash: HASH, ts: i }))
const noop = () => {}

function Row({ kind }: { kind: (typeof KINDS)[number] }) {
  if (kind === 'loose') {
    return (
      <FileCard
        file={loose} decoration={null} seeded={false} spaceId="s1" members={members} recipients={received(loose.path, '__loose__')}
        onDownload={noop} onCancel={noop} onPause={noop} onReveal={noop} onUnshare={noop} onCancelPublish={noop}
      />
    )
  }
  return (
    <ShareFileRow
      file={folderFile} decoration={null} seeded={false} isOwn manualControls={false} spaceId="s1" members={members}
      downloadSummary={null} recipients={received(NAME, 'share1')} ownerKey={OWNER} leadingGutter
      onDownload={noop} onReveal={noop} onPause={noop} onCancel={noop}
    />
  )
}

let setOrphanStatus: (status: ShareFileStatus) => void = noop

function OrphanRow() {
  const [status, setStatus] = useState<ShareFileStatus>('synced')
  setOrphanStatus = setStatus
  return (
    <ShareFileRow
      file={{ ...folderFile, status }} decoration={null} seeded={false} isOwn manualControls={false} spaceId="s1" members={members}
      downloadSummary={null} recipients={received(NAME, 'share1')} ownerKey={OWNER}
      onDownload={noop} onReveal={noop} onPause={noop} onCancel={noop}
    />
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8 space-y-4">
    {KINDS.flatMap((kind) => WIDTHS.map(({ id, w }) => (
      <div key={kind + id} data-row={kind + '-' + id} style={{ width: w }}>
        <Row kind={kind} />
      </div>
    )))}
    <div data-row="orphan" style={{ width: 880 }}><OrphanRow /></div>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const visible = (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function measure(key: string): RowMetrics | null {
  const host = document.querySelector(`[data-row="${key}"]`)
  const card = host?.firstElementChild
  const line = card?.firstElementChild
  const toggle = host?.querySelector('button[aria-expanded]')
  const name = host?.querySelector('.font-bold.text-accent')
  if (!(card instanceof HTMLElement) || !(line instanceof HTMLElement) || !toggle || !name) return null
  const c = card.getBoundingClientRect()
  const tr = toggle.getBoundingClientRect()
  return {
    overflow: line.scrollWidth > line.clientWidth + 1,
    toggleHeight: tr.height,
    toggleInside: tr.left >= c.left - 0.5 && tr.right <= c.right + 0.5,
    facesVisible: visible(host?.querySelector('[role="img"][aria-label^="Recently received by"]')),
    fullVisible: visible(toggle.querySelector('[data-recipients-text="full"]')),
    shortVisible: visible(toggle.querySelector('[data-recipients-text="short"]')),
    nameWidth: name.getBoundingClientRect().width,
  }
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  const expected = KINDS.length * WIDTHS.length
  while (document.querySelectorAll('button[aria-expanded]').length < expected && Date.now() < deadline) await sleep(50)
  await document.fonts.ready
  await sleep(100)
  const rows: Record<string, RowMetrics> = {}
  let pass = true
  for (const kind of KINDS) {
    for (const { id, faces, full } of WIDTHS) {
      const key = kind + '-' + id
      const m = measure(key)
      if (!m) { window.__results = { pass: false, error: 'row ' + key + ' did not render its recipients toggle', rows }; return }
      rows[key] = m
      pass = pass && !m.overflow && m.toggleInside && m.toggleHeight <= TOGGLE_MAX_HEIGHT && m.nameWidth >= NAME_MIN
        && m.facesVisible === faces && m.fullVisible === full && m.shortVisible === !full
    }
  }
  const orphan = await openThenPublish()
  window.__results = { pass: pass && orphan.opened && !orphan.orphaned, error: null, rows, orphan }
}

async function openThenPublish(): Promise<{ opened: boolean; orphaned: boolean }> {
  const toggle = document.querySelector('[data-row="orphan"] button[aria-expanded]')
  if (!(toggle instanceof HTMLElement)) return { opened: false, orphaned: false }
  toggle.click()
  await sleep(100)
  const id = toggle.getAttribute('aria-controls')
  const opened = !!id && !!document.getElementById(id)
  setOrphanStatus('publishing')
  await sleep(100)
  return { opened, orphaned: !!id && !!document.getElementById(id) }
}

run()
