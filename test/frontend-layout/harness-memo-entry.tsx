// Real-Chromium render-count harness for the row memo discipline (r04-7 / r03-9).
//
// The complaint this guards: while a transfer is live, useDecorations' 1 Hz heartbeat sets state
// on the SCREEN, so the screen and every row under it re-rendered once a second. Fixing that has
// two halves and this harness fails if either regresses:
//   1. the rows are memoized, and
//   2. the props they receive keep their identity — the listing rows across a reconcile
//      (shareFilesReconcile.js) and the handlers across a render (useFiles/useTransferControls).
//   3. a live transfer frame reaches ONE row without touching the listing array, so the two O(n)
//      walks FolderScreen runs over it (buildFileTree, then filterTree) do not re-run per frame.
//      `treeBuilds` is the measurement: it must not move when a decoration lands.
//   4. the space's Download-to state (the real useDownloadTo) keeps its identity when ANOTHER
//      space's folder changes, so no row moves; a change of this space's folder reaches every row.
//   5. it keeps its identity, too, when the worker answers settings or the folders' reachability
//      again with the same values — fresh objects off the wire, as a remount or a resync reads them
//      (REGRESSION (FIX-DLTO-R28: every such answer re-rendered every row).
//
// HOW THE COUNT IS HONEST. The counter cannot live inside the real FileRow without editing
// it, and a plain unmemoized wrapper around it would count the WRAPPER's renders — which happen on
// every parent render regardless of whether the memo bailed, so it would fail even against a
// perfect implementation. Instead `Counted` is itself memo()'d with the DEFAULT shallow compare,
// which matches the real `memo(FileRow, sameProps)` for every prop this harness passes (sameProps is
// shallow except for the selection box, which no row here carries). `memoized()` below closes the
// remaining gap by asserting the real export is a memo whose comparator bails on identical props
// and re-renders on any changed one, so the two checks together are equivalent to counting the
// real component.
import './harness-bootstrap.js'
import { memo, useCallback, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import FileRow, { type ShareFileRowProps } from '../../src/renderer/components/cards/FileRow.js'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import { useDownloadTo } from '../../src/renderer/hooks/useDownloadTo.js'
import { useSettings } from '../../src/renderer/hooks/useSettings.js'
import { reconcileFiles } from '../../src/renderer/model/share-files-reconcile.js'
import { refetchQuery } from '../../src/renderer/store/query-store.js'
import { SETTINGS_SCOPES } from '../../src/renderer/store/scopes.js'
import { buildFileTree } from '../../src/renderer/model/file-tree.js'
import type { Decoration } from '../../src/renderer/types/ui.js'
import type { FileTreeNode, ShareFileRow as ShareFileRowData, SpaceMember, PeerDownloadSummary, FileRecipient, Space } from '../../src/renderer/types/types.js'

interface HarnessResults {
  pass: boolean
  error: string | null
  isMemo: boolean
  mountCounts: Record<string, number>
  afterIdleTick: Record<string, number>
  afterOneSummary: Record<string, number>
  afterUnchangedRefetch: Record<string, number>
  afterOneRowChanged: Record<string, number>
  afterOneDecoration: Record<string, number>
  treeBuildsBeforeDecoration: number
  treeBuildsAfterDecoration: number
  afterOtherSpaceFolder: Record<string, number>
  afterOwnSpaceFolder: Record<string, number>
  afterEqualSettings: Record<string, number>
  afterEqualRoots: Record<string, number>
}

declare global {
  interface Window {
    __results: HarnessResults
    __tick: () => void
    __setSummary: (relPath: string) => void
    __refetch: (changed: string | null) => void
    __decorate: (relPath: string) => void
    __moveFolder: (spaceId: string) => void
  }
}

const PATHS = ['a.txt', 'b.txt', 'c.txt', 'd.txt']

function entry(relPath: string, extra: Partial<ShareFileRowData> = {}): ShareFileRowData {
  return { relPath, size: 1024, hash: 'h-' + relPath, mtime: 0, status: 'remote', localPath: null, ...extra }
}

// A fresh listing straight off the wire: every row is a NEW object, exactly as the worker sends
// them. Whether the rows keep their identity is reconcileFiles' job, which is the point.
function freshListing(changed: string | null): ShareFileRowData[] {
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
}
const MEMBERS: SpaceMember[] = []
const NO_RECIPIENTS: FileRecipient[] = []

const space = (spaceId: string, downloadFolder: string): Space => ({
  spaceId, name: spaceId, icon: 'folder', topic: 't'.repeat(64), created: '2026-01-01', members: [], favorite: false, schemaVersion: 2, downloadFolder,
})

const renders: Record<string, number> = {}
function snapshot(): Record<string, number> {
  return { ...renders }
}

// The memo under test lives in useFilteredTree, which FolderScreen calls: buildFileTree(files) on
// [files], filterTree on [tree, …]. This harness re-implements the same useMemo rather than calling
// the hook, because the hook also owns expansion state and a session store the harness has no
// business driving — but that means it measures the SHAPE, not the hook. If useFilteredTree ever
// drops a dep, this still passes. The hook's own deps are pinned in test/invariants/folder-memo-deps.
let treeBuilds = 0
function countedTree(files: ShareFileRowData[]): FileTreeNode[] {
  treeBuilds++
  return buildFileTree(files)
}

const Counted = memo(function Counted(props: ShareFileRowProps) {
  renders[props.file.relPath] = (renders[props.file.relPath] ?? 0) + 1
  return <FileRow {...props} />
})

// The real export must be a memo whose comparator bails on identical props and re-renders on any
// changed one, which is what the default shallow compare Counted uses does. React stores the
// comparator as `compare`, null when it was omitted.
type Compare = (a: object, b: object) => boolean
function memoized(component: unknown): boolean {
  const c = component as { $$typeof?: symbol; compare?: Compare | null } | null
  if (!c || c.$$typeof !== Symbol.for('react.memo')) return false
  if (!c.compare) return true
  const props = { file: entry('a.txt'), decoration: null, downloadTo: {}, onDownload: noop }
  return c.compare(props, { ...props }) &&
    !c.compare(props, { ...props, file: entry('a.txt') }) &&
    !c.compare(props, { ...props, downloadTo: {} }) &&
    !c.compare(props, { ...props, onDownload: () => {} })
}

function Harness() {
  // Stands in for useDecorations' heartbeat: state on the SCREEN, re-rendering it every tick.
  const [, setTick] = useState(0)
  const [files, setFiles] = useState<ShareFileRowData[]>(() => freshListing(null))
  const [summaries, setSummaries] = useState<Map<string, PeerDownloadSummary>>(() => new Map())
  const [decorations, setDecorations] = useState<Map<string, Decoration>>(() => new Map())
  // The spaces list as a refetch hands it over: every space a new object, whichever one changed.
  const [spaces, setSpaces] = useState<Space[]>(() => [space('s', '/Users/you/Downloads'), space('other', '/Users/you/Other')])
  const downloadTo = useDownloadTo(spaces.find((sp) => sp.spaceId === 's'))
  const { data: settings } = useSettings()

  window.__moveFolder = useCallback((spaceId: string) => {
    setSpaces((prev) => prev.map((sp) => ({ ...sp, downloadFolder: sp.spaceId === spaceId ? sp.downloadFolder + '-moved' : sp.downloadFolder })))
  }, [])

  window.__tick = useCallback(() => { setTick((t) => t + 1) }, [])

  // One path's summary changes; the other entries keep their identity, as usePeerDownloads' Map
  // updates do.
  window.__setSummary = useCallback((relPath: string) => {
    setSummaries((prev) => {
      const next = new Map(prev)
      next.set(relPath, { spaceId: 's', path: relPath, personKeys: ['peer'], pausedKeys: [], waitingKeys: [], bytes: 512, total: 1024, avgSpeed: 100 })
      return next
    })
  }, [])

  // One path's transfer frame lands, as useDecorations' Map update does. The listing array is not
  // touched, which is the property this harness measures.
  window.__decorate = useCallback((relPath: string) => {
    setDecorations((prev) => {
      const next = new Map(prev)
      next.set(relPath, { bytes: 512, total: 1024, speed: 100, avgSpeed: 100, eta: 5 })
      return next
    })
  }, [])

  // A listing refetch through the REAL reconciler, complete:true — the ordinary owner-side read.
  window.__refetch = useCallback((changed: string | null) => {
    setFiles((prev) => reconcileFiles(prev, freshListing(changed), { complete: true }))
  }, [])

  const tree = useMemo(() => countedTree(files), [files])

  const rows = useMemo(() => files.map((file) => (
    <Counted
      kind="share"
      key={file.relPath}
      file={file}
      displayName={file.relPath}
      decoration={decorations.get(file.relPath) ?? null}
      seeded={false}
      isOwn={false}
      manualControls={false}
      spaceId="s"
      members={MEMBERS}
      downloadSummary={summaries.get(file.relPath) ?? null}
      recipients={NO_RECIPIENTS}
      ownerKey="o"
      downloadTo={downloadTo}
      {...HANDLERS}
    />
  )), [files, summaries, decorations, downloadTo])

  // The rows mount once the settings are in, as the screens' do behind their own loading states:
  // the host's path rules arrive with them.
  return <div id="rows-host" data-tree-nodes={tree.length} className="max-w-3xl">{settings ? rows : null}</div>
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8"><ToastProvider><Harness /></ToastProvider></div>,
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
    afterOneDecoration: {},
    treeBuildsBeforeDecoration: -1,
    treeBuildsAfterDecoration: -1,
    afterOtherSpaceFolder: {},
    afterOwnSpaceFolder: {},
    afterEqualSettings: {},
    afterEqualRoots: {},
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

  const isMemo = memoized(FileRow)
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

  // 5. A transfer frame for one path reaches that row and nothing else — and, the point of moving
  //    the decoration off the row, leaves the listing array alone so the tree is not rebuilt.
  const treeBuildsBeforeDecoration = treeBuilds
  window.__decorate('a.txt')
  await sleep(100)
  const afterOneDecoration = snapshot()
  const treeBuildsAfterDecoration = treeBuilds
  const oneDecorationScoped = delta(afterOneRowChanged, afterOneDecoration).join(',') === 'a.txt'
  const treeQuiet = treeBuildsAfterDecoration === treeBuildsBeforeDecoration

  // 6. Another space's download folder changes: this space's Download-to state keeps its identity,
  //    so no row moves. Then this space's own folder changes, which every row must see.
  window.__moveFolder('other')
  await sleep(100)
  const afterOtherSpaceFolder = snapshot()
  const otherFolderQuiet = delta(afterOneDecoration, afterOtherSpaceFolder).length === 0
  window.__moveFolder('s')
  await sleep(100)
  const afterOwnSpaceFolder = snapshot()
  const ownFolderReachesRows = delta(afterOtherSpaceFolder, afterOwnSpaceFolder).length === PATHS.length

  // 7. The same settings, then the same reachability, answered again as fresh objects: no row moves.
  await refetchQuery('settings:get', {}, SETTINGS_SCOPES)
  await sleep(100)
  const afterEqualSettings = snapshot()
  const equalSettingsQuiet = delta(afterOwnSpaceFolder, afterEqualSettings).length === 0
  await refetchQuery('downloads:roots-status', {}, null)
  await sleep(100)
  const afterEqualRoots = snapshot()
  const equalRootsQuiet = delta(afterEqualSettings, afterEqualRoots).length === 0

  window.__results = {
    pass: isMemo && mountedOnce && idleTickQuiet && oneSummaryScoped && unchangedRefetchQuiet &&
      oneRowScoped && oneDecorationScoped && treeQuiet && otherFolderQuiet && ownFolderReachesRows &&
      equalSettingsQuiet && equalRootsQuiet,
    error: null,
    isMemo,
    mountCounts,
    afterIdleTick,
    afterOneSummary,
    afterUnchangedRefetch,
    afterOneRowChanged,
    afterOneDecoration,
    treeBuildsBeforeDecoration,
    treeBuildsAfterDecoration,
    afterOtherSpaceFolder,
    afterOwnSpaceFolder,
    afterEqualSettings,
    afterEqualRoots,
  }
}

run()
