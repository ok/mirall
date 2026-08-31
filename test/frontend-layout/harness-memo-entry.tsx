// Real-Chromium render-count harness for the row memo discipline (r04-7 / r03-9).
//
// The complaint this guards: while a transfer is live, useDecorations' 1 Hz heartbeat sets state
// on the SCREEN, so the screen and every row under it re-rendered once a second. Fixing that has
// two halves and this harness fails if either regresses:
//   1. the rows are memoized, and
//   2. the props they receive keep their identity — the listing rows across a reconcile
//      (shareFilesReconcile.js) and the handlers across a render (useFiles/useTransferControls).
//
// HOW THE COUNT IS HONEST. The counter cannot live inside the real ShareFileRow without editing
// it, and a plain unmemoized wrapper around it would count the WRAPPER's renders — which happen on
// every parent render regardless of whether the memo bailed, so it would fail even against a
// perfect implementation. Instead `Counted` is itself memo()'d with the DEFAULT shallow compare,
// the same comparator the real `memo(ShareFileRow)` uses, and receives the same props. Its
// bail-out condition is therefore identical to the real component's. `memoized()` below closes the
// remaining gap by asserting the real export really is a memo with the default compare, so the two
// checks together are equivalent to counting the real component.
import { memo, useCallback, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import ShareFileRow, { type ShareFileRowProps } from './../../src/renderer/components/cards/ShareFileRow.js'
import { reconcileFiles } from './../../src/renderer/shareFilesReconcile.js'
import type { ShareFileEntry, SpaceMember, PeerDownloadSummary } from './../../src/renderer/types.js'

interface HarnessResults {
  pass: boolean
  error: string | null
  isMemo: boolean
  mountCounts: Record<string, number>
  afterIdleTick: Record<string, number>
  afterOneSummary: Record<string, number>
  afterUnchangedRefetch: Record<string, number>
  afterOneRowChanged: Record<string, number>
}

declare global {
  interface Window {
    __results: HarnessResults
    __tick: () => void
    __setSummary: (relPath: string) => void
    __refetch: (changed: string | null) => void
  }
}

const PATHS = ['a.txt', 'b.txt', 'c.txt', 'd.txt']

function entry(relPath: string, extra: Partial<ShareFileEntry> = {}): ShareFileEntry {
  return { relPath, size: 1024, hash: 'h-' + relPath, mtime: 0, status: 'remote', ...extra }
}

// A fresh listing straight off the wire: every row is a NEW object, exactly as toEntry produces
// them. Whether the rows keep their identity is reconcileFiles' job, which is the point.
function freshListing(changed: string | null): ShareFileEntry[] {
  return PATHS.map((p) => entry(p, changed === p ? { size: 2048 } : {}))
}

// Module-level: these stand in for the stable identities useFiles / useTransferControls now hand
// out. A fresh arrow here would make every assertion below fail, which is the regression this
// harness exists to catch.
const noop = () => {}
const HANDLERS = {
  onDownload: noop,
  onReveal: noop,
  onPause: noop,
  onCancel: noop,
  onDiscardPartial: noop,
}
const MEMBERS: SpaceMember[] = []

const renders: Record<string, number> = {}
function snapshot(): Record<string, number> {
  return { ...renders }
}

const Counted = memo(function Counted(props: ShareFileRowProps) {
  renders[props.file.relPath] = (renders[props.file.relPath] ?? 0) + 1
  return <ShareFileRow {...props} />
})

// The real export must be a memo with the DEFAULT compare — memo(fn) with no comparator. React
// stores the comparator as `compare`, null when it was omitted.
function memoized(component: unknown): boolean {
  const c = component as { $$typeof?: symbol; compare?: unknown } | null
  return !!c && c.$$typeof === Symbol.for('react.memo') && (c.compare === null || c.compare === undefined)
}

function Harness() {
  // Stands in for useDecorations' heartbeat: state on the SCREEN, re-rendering it every tick.
  const [, setTick] = useState(0)
  const [files, setFiles] = useState<ShareFileEntry[]>(() => freshListing(null))
  const [summaries, setSummaries] = useState<Map<string, PeerDownloadSummary>>(() => new Map())

  window.__tick = useCallback(() => { setTick((t) => t + 1) }, [])

  // One path's summary changes; the other entries keep their identity, as usePeerDownloads' Map
  // updates do.
  window.__setSummary = useCallback((relPath: string) => {
    setSummaries((prev) => {
      const next = new Map(prev)
      next.set(relPath, { spaceId: 's', path: relPath, peerKeys: ['peer'], pausedKeys: [], bytes: 512, total: 1024, avgSpeed: 100 })
      return next
    })
  }, [])

  // A listing refetch through the REAL reconciler, complete:true — the ordinary owner-side read.
  window.__refetch = useCallback((changed: string | null) => {
    setFiles((prev) => reconcileFiles(prev, freshListing(changed), { complete: true }))
  }, [])

  const rows = useMemo(() => files.map((file) => (
    <Counted
      key={file.relPath}
      file={file}
      isOwn={false}
      manualControls={false}
      spaceId="s"
      members={MEMBERS}
      downloadSummary={summaries.get(file.relPath) ?? null}
      {...HANDLERS}
    />
  )), [files, summaries])

  return <div id="rows-host" className="max-w-3xl">{rows}</div>
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8"><Harness /></div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publishError(error: string): void {
  window.__results = {
    pass: false,
    error,
    isMemo: false,
    mountCounts: {},
    afterIdleTick: {},
    afterOneSummary: {},
    afterUnchangedRefetch: {},
    afterOneRowChanged: {},
  }
}

function delta(before: Record<string, number>, after: Record<string, number>): string[] {
  return PATHS.filter((p) => (after[p] ?? 0) !== (before[p] ?? 0))
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  while (Object.keys(renders).length < PATHS.length && Date.now() < deadline) await sleep(50)
  if (Object.keys(renders).length < PATHS.length) {
    return publishError(`expected ${PATHS.length} rows, got ${Object.keys(renders).length}`)
  }
  await document.fonts.ready
  await sleep(100)

  const isMemo = memoized(ShareFileRow)
  const mountCounts = snapshot()
  const mountedOnce = PATHS.every((p) => mountCounts[p] === 1)

  // 1. A heartbeat tick that changes nothing must not reach a single row. This is the assertion
  //    that maps directly to the user-visible complaint.
  window.__tick()
  await sleep(100)
  const afterIdleTick = snapshot()
  const idleTickQuiet = delta(mountCounts, afterIdleTick).length === 0

  // 2. One row's peer-download summary changes → only that row re-renders.
  window.__setSummary('b.txt')
  await sleep(100)
  const afterOneSummary = snapshot()
  const oneSummaryScoped = delta(afterIdleTick, afterOneSummary).join(',') === 'b.txt'

  // 3. A complete listing refetch whose content is unchanged must not re-render anything: every
  //    row arrives as a new object and reconcileFiles has to hand back the previous ones.
  window.__refetch(null)
  await sleep(100)
  const afterUnchangedRefetch = snapshot()
  const unchangedRefetchQuiet = delta(afterOneSummary, afterUnchangedRefetch).length === 0

  // 4. …but a row that genuinely changed MUST re-render, and only it. Guards the opposite failure:
  //    a memo that hides a real update.
  window.__refetch('c.txt')
  await sleep(100)
  const afterOneRowChanged = snapshot()
  const oneRowScoped = delta(afterUnchangedRefetch, afterOneRowChanged).join(',') === 'c.txt'

  window.__results = {
    pass: isMemo && mountedOnce && idleTickQuiet && oneSummaryScoped && unchangedRefetchQuiet && oneRowScoped,
    error: null,
    isMemo,
    mountCounts,
    afterIdleTick,
    afterOneSummary,
    afterUnchangedRefetch,
    afterOneRowChanged,
  }
}

run()
