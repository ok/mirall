// Keyboard focus across a row's action swap (LOCAL/dev-machine only — spawns a real Electron GUI
// process). REGRESSION (FIX-DLTO-R12: picking a folder from a row's Download-to menu started the
// download, the row's primary slot swapped the menu trigger for Pause, and keyboard focus fell to
// the page). Mounts a REAL folder <FileRow> with the real useDownloadTo, drives the menu from the
// keyboard, then changes the row's status the way a listing refetch does, and asserts where focus
// lands each time:
//   - a pick, then the download starts: focus is on Pause (the new primary);
//   - Discard, then the row is back to remote: focus is on "Download to…";
//   - the row turns busy (no control at all): focus stays in the lane;
//   - focus the user moved elsewhere, or let go of, is never taken back.
import './harness-bootstrap.js'
import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import FileRow from '../../src/renderer/components/cards/FileRow.js'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import { useDownloadTo } from '../../src/renderer/hooks/useDownloadTo.js'
import type { FileStatus, ShareFileRow, Space, SpaceMember, FileRecipient } from '../../src/renderer/types/types.js'

interface Step {
  name: string
  focus: string
  pass: boolean
}

interface Results {
  pass: boolean
  error: string | null
  picked: string | null
  steps: Step[]
}

declare global {
  interface Window {
    __results: Results
    __setRow: (status: FileStatus, transferId?: string) => void
  }
}

const SPACE: Space = {
  spaceId: 's', name: 'Studio', icon: 'folder', topic: 't'.repeat(64), created: '2026-01-01', members: [], favorite: false, schemaVersion: 2, downloadFolder: '/Users/you/Downloads',
}
const MEMBERS: SpaceMember[] = []
const NO_RECIPIENTS: FileRecipient[] = []
const noop = () => {}
let picked: string | null = null

function Harness() {
  const [file, setFile] = useState<ShareFileRow>({ relPath: 'Brief.pdf', size: 1024, hash: 'h'.repeat(64), mtime: 0, status: 'remote', localPath: null })
  const downloadTo = useDownloadTo(SPACE)
  window.__setRow = useCallback((status: FileStatus, transferId?: string) => {
    setFile((prev) => ({ ...prev, status, transferId }))
  }, [])
  const onDownload = useCallback((relPath: string, folder?: string) => { picked = `${relPath} → ${folder ?? 'the space\'s folder'}` }, [])
  return (
    <div className="max-w-3xl space-y-4">
      <button type="button" id="elsewhere">Elsewhere</button>
      <FileRow
        kind="share"
        file={file}
        displayName={file.relPath}
        decoration={null}
        seeded={false}
        isOwn={false}
        manualControls
        spaceId="s"
        members={MEMBERS}
        downloadSummary={null}
        recipients={NO_RECIPIENTS}
        ownerKey="o"
        downloadTo={downloadTo}
        onDownload={onDownload}
        onReveal={noop}
        onPause={noop}
        onCancel={noop}
      />
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8"><ToastProvider><Harness /></ToastProvider></div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const key = (el: Element | null, k: string) =>
  el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const control = (name: string) => document.querySelector<HTMLElement>(`button[aria-label="${name}"]`)

// What has focus, as a person would name it.
function focused(): string {
  const el = document.activeElement
  if (!el || el === document.body) return 'the page'
  // The lane itself, holding the busy indicator rather than a control.
  if (el.querySelector('[role=status]')) return 'the action lane'
  return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName.toLowerCase()
}

async function run(): Promise<Results> {
  const deadline = Date.now() + 5000
  while (!control('Download to…') && Date.now() < deadline) await sleep(50)
  const trigger = control('Download to…')
  if (!trigger) return { pass: false, error: 'the row\'s Download to… never rendered', picked, steps: [] }
  const steps: Step[] = []
  const expect = (name: string, focus: string) => {
    const now = focused()
    steps.push({ name, focus: now, pass: now === focus })
  }

  // A keyboard pick: open, take the space's folder, the menu closes and hands focus back.
  trigger.focus()
  key(trigger, 'ArrowDown')
  await sleep(150)
  key(document.activeElement, 'Enter')
  await sleep(200)
  expect('the menu hands focus back to its trigger', 'Download to…')
  window.__setRow('downloading', 't1')
  await sleep(150)
  expect('the download starts: focus moves to Pause', 'Pause Download')

  // Discard (the lane's secondary) on a paused row, then the row is back to remote.
  window.__setRow('paused-interrupted', 't1')
  await sleep(150)
  control('Discard Partial')?.focus()
  window.__setRow('remote')
  await sleep(150)
  expect('the partial is discarded: focus moves to Download to…', 'Download to…')

  // A row with no control left keeps focus in its lane.
  window.__setRow('preparing')
  await sleep(150)
  expect('the row turns busy: focus stays in its lane', 'the action lane')

  // Focus the user moved elsewhere stays there.
  window.__setRow('downloading', 't2')
  await sleep(150)
  control('Pause Download')?.focus()
  document.getElementById('elsewhere')?.focus()
  window.__setRow('remote')
  await sleep(150)
  expect('focus moved elsewhere is left there', 'Elsewhere')

  // Focus the user let go of (a click on the page) is not taken back.
  control('Download to…')?.focus()
  ;(document.activeElement as HTMLElement | null)?.blur()
  await sleep(50)
  window.__setRow('downloading', 't3')
  await sleep(150)
  expect('focus let go of is not taken back', 'the page')

  return { pass: picked !== null && steps.every((s) => s.pass), error: null, picked, steps }
}

run().then(
  (results) => { window.__results = results },
  (e: unknown) => { window.__results = { pass: false, error: String(e), picked, steps: [] } },
)
