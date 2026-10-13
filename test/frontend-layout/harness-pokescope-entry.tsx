// Which listing re-reads on which reconcile hint, under the real query store and the real hooks
// (LOCAL/dev-machine only — spawns a real Electron GUI process). A view that no longer matches its
// hint keeps stale rows while every data-polling test still converges, so the refetch itself is
// what this counts: one `files:list` (the loose list), one `share:list-files` per folder share and
// one `space:storage-summary`, all mounted together on one space.
import './harness-bootstrap.js'
import '../../src/renderer/platform/i18n.js'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import { useFiles } from '../../src/renderer/hooks/useFiles.js'
import { useShareFiles } from '../../src/renderer/hooks/useShareFiles.js'
import { useSpaceStorage } from '../../src/renderer/hooks/useSpaceStorage.js'
import { LOOSE_SHARE_ID } from '../../src/shared/contract/entry-ref.js'

type Counts = Record<string, number>
interface Step { hint: Record<string, string>; delta: Counts; expected: Counts; ok: boolean }
interface HarnessResults { pass: boolean; error: string | null; cold: Counts; steps: Step[] }

declare global {
  interface Window {
    __results: HarnessResults
    __fakeEmit: (frame: unknown) => void
  }
}

const SPACE = 'space1'
const OWNER = 'owner-pk'
const VIEWS = ['files:list', 'share:list-files:share1', 'share:list-files:share2', 'space:storage-summary']

// Counted at the bridge, so every request the store really issues is seen, whoever issued it.
const counts: Counts = Object.fromEntries(VIEWS.map((v) => [v, 0]))
const dec = new TextDecoder('utf-8')
const write = window.bridge.writeWorkerIPC
window.bridge.writeWorkerIPC = (spec, data) => {
  for (const line of dec.decode(data).split('\n')) {
    if (!line) continue
    let env: { type?: string; shareId?: string }
    try { env = JSON.parse(line) } catch { continue }
    const key = env.type === 'share:list-files' ? env.type + ':' + env.shareId : env.type
    if (key && key in counts) counts[key]++
  }
  return write(spec, data)
}

function Views() {
  useFiles(SPACE)
  useShareFiles(SPACE, OWNER, 'share1')
  useShareFiles(SPACE, OWNER, 'share2')
  useSpaceStorage(SPACE)
  return null
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
// Past the views' 750 ms coalesce window and the leading + trailing fetch it allows.
const SETTLE_MS = 1600
const snapshot = (): Counts => ({ ...counts })
const diff = (a: Counts, b: Counts): Counts => Object.fromEntries(VIEWS.map((v) => [v, b[v] - a[v]]))
const expect = (moved: string[]): Counts => Object.fromEntries(VIEWS.map((v) => [v, moved.includes(v) ? 1 : 0]))

const STEPS: Array<{ hint: Record<string, string>; moved: string[] }> = [
  // A loose-list poke (catalog append, publish, engine status) reaches the loose list and the total.
  { hint: { kind: 'share-files', spaceId: SPACE, shareId: LOOSE_SHARE_ID }, moved: ['files:list', 'space:storage-summary'] },
  // A folder poke reaches that folder and the total, never the loose list or the other folder.
  { hint: { kind: 'share-files', spaceId: SPACE, shareId: 'share1' }, moved: ['share:list-files:share1', 'space:storage-summary'] },
  // The space-wide poke (presence, roster, download root) reaches every listing.
  { hint: { kind: 'share-files', spaceId: SPACE }, moved: VIEWS },
  // Another space reaches nothing here.
  { hint: { kind: 'share-files', spaceId: 'space2' }, moved: [] },
  // The retired kind matches no view.
  { hint: { kind: 'files', spaceId: SPACE }, moved: [] },
]

async function run(): Promise<HarnessResults> {
  createRoot(document.getElementById('root') as HTMLElement).render(<ToastProvider><Views /></ToastProvider>)
  await sleep(SETTLE_MS)
  const cold = snapshot()
  const steps: Step[] = []
  for (const { hint, moved } of STEPS) {
    const before = snapshot()
    window.__fakeEmit({ type: 'event:reconcile', scope: hint })
    await sleep(SETTLE_MS)
    const delta = diff(before, snapshot())
    const expected = expect(moved)
    steps.push({ hint, delta, expected, ok: VIEWS.every((v) => delta[v] === expected[v]) })
  }
  const coldOk = VIEWS.every((v) => cold[v] === 1)
  return { pass: coldOk && steps.every((s) => s.ok), error: null, cold, steps }
}

run().then(
  (results) => { window.__results = results },
  (e: Error) => { window.__results = { pass: false, error: String(e), cold: {}, steps: [] } },
)
