// The invariant tables the flat config applies and the guard tests read back. They live here rather
// than in eslint.config.mjs because they are the statement of an invariant, not lint configuration:
// a test asserts each one still describes the tree, and eslint.config.mjs is left as the ~160 lines
// of actual config.

const statusMessage = 'Do not construct row status in an event handler — status is worker-derived (level-triggered). Decorate instead.'
export const rendererStatusRestrictions = [
  { selector: "CallExpression[callee.name='subscribe'] ObjectExpression > Property[key.name='status']", message: statusMessage },
  { selector: "CallExpression[callee.name='subscribe'] ObjectExpression > Property[key.value='status']", message: statusMessage },
]

// Lifecycle invariant, import-time corner only: a timer armed at module level runs at import, so no
// close() can reach it. The broad property (every periodic call dies with its subsystem) is not
// decidable statically; test/integration/timer-lifecycle.test.js measures it at runtime. Exported so
// test/invariants/module-level-timers.test.js parses the same grammar.
export const moduleLevelTimerRestrictions = [{
  // `:not(:function *)` alone is the whole rule: it matches a set*() call that has no function
  // ancestor, i.e. one that runs at import. Scoping it to top-level statement types instead would
  // miss every nesting a module-level timer can hide in — a top-level `if`, `try`, bare block,
  // labelled block, `for`/`while`, `switch` case, or a class static field or static block.
  selector: "CallExpression[callee.name=/^set(Interval|Timeout)$/]:not(:function *)",
  message: 'No timer armed at import — nothing can clear it. Arm it inside a Subsystem _open through this.timers, or inside a function whose module holds a matching clear.',
}]

// The shape the rule above cannot see: a timer armed INSIDE a function but held in a long-lived
// handle, which outlives every call. `xTimer = setTimeout(...)` is un-owned; `xTimer =
// timers.setTimeout(...)` (or `this.timers.`) is owned and does not match. The name pattern is the
// camelCase COMPOUND (`announceTimer`, `presenceBeat`), never a bare `timer` — a bare local is owned
// by its function. Blind spot, stated: a module-scope handle called `pending` slips through; a
// genuine exception is one inline disable with a reason next to it.
const timerHandleMessage = 'This timer handle outlives the call that arms it — arm it through a Subsystem\'s `this.timers` (or a createTimers() the module\'s own reset closes), so one call clears every one of them.'
export const moduleScopeTimerHandleRestrictions = [
  {
    selector: "AssignmentExpression[left.type='Identifier'][left.name=/[a-z0-9]Timer$|[a-z0-9]Beat$/][right.callee.name=/^set(Interval|Timeout)$/]",
    message: timerHandleMessage,
  },
  // The same handle kept on an object rather than in a binding — `this.sweepTimer = setInterval(…)`
  // is the most natural shape in a Subsystem-based codebase and outlives its call exactly as much.
  // `this.timers.setTimeout(…)` is unaffected: a member callee has no `callee.name` to match.
  {
    selector: "AssignmentExpression[left.type='MemberExpression'][left.property.name=/[a-z0-9]Timer$|[a-z0-9]Beat$/][right.callee.name=/^set(Interval|Timeout)$/]",
    message: timerHandleMessage,
  },
  {
    selector: "Program > VariableDeclaration > VariableDeclarator[id.name=/[a-z0-9]Timer$|[a-z0-9]Beat$/][init.callee.name=/^set(Interval|Timeout)$/]",
    message: timerHandleMessage,
  },
]

// Mechanism invariant: chokidar's options are per-INSTANCE (network mounts need polling, an erroring
// watcher spins), and src/main/watch-host.js is the single owner of every chokidar decision; a second
// require('chokidar') is how a divergence comes back. Exported so
// test/invariants/watch-host-single-owner.test.js parses the same grammar.
const chokidarMessage = 'Only src/main/watch-host.js may load chokidar — arm the watch through createWatchHost so network polling, the error-storm cut-off and the option bag stay in one place.'
export const chokidarSingleOwnerRestrictions = [
  { selector: "CallExpression[callee.name='require'][arguments.0.value='chokidar']", message: chokidarMessage },
  { selector: "ImportDeclaration[source.value='chokidar']", message: chokidarMessage },
]

// Boundary invariant: the renderer may import the contract package and nothing else under
// src/shared/. The data layer imports bare-*, Hyper* and Node modules the sandboxed renderer cannot
// bundle, and every renderer "twin" this codebase has deleted began as an import that was not
// allowed and a copy that was. The re-export shims that used to stand in for this rule are gone;
// the rule is what replaces them. Exported so test/invariants/renderer-contract-only-imports.test.js
// enforces the same grammar through eslint's parser.
export const rendererContractOnlyImports = [{
  regex: '(^|/)shared/(?!contract/)',
  message: 'The renderer may import src/shared/contract/** and nothing else under src/shared/ — move the rule into the contract package or ask the worker over IPC.',
}]

// Presentation invariant: one byte size means one string. src/renderer/format/bytes.js owns the decimal
// ladder because the divisor and the labels must agree; a unit-ladder array literal is the shape a
// re-implementation always takes, whatever it is named. Exported so
// test/invariants/byte-formatter-single-owner.test.js parses the same grammar.
const byteLadderMessage = 'Only src/renderer/format/bytes.js may declare a byte-unit ladder — call formatSize so the divisor and the labels stay in one place.'
export const byteFormatterSingleOwnerRestrictions = ['KB', 'MB', 'GB', 'TB', 'KiB', 'MiB', 'GiB', 'TiB'].map((unit) => ({
  selector: `ArrayExpression > Literal[value='${unit}']`,
  message: byteLadderMessage,
}))

// Stale-response invariant, two tables because the two cases are not the same risk. What is
// forbidden is an async effect with NO guard; the tables name the exceptions.
// UNMOUNT_ONLY: [] deps and one in-flight read, so nothing can supersede it — the only race is a
// write after unmount, which React tolerates.
export const unmountOnlyAsyncEffects = Object.freeze({
  'src/renderer/hooks/useConnectionStatus.tsx': { effects: 1, why: 'The net.online probe has [] deps and one read; transitions arrive on onNetOnlineChange. (The other effect in this file carries a cleanup flag and is not exempt.)' },
  'src/renderer/screens/AccountScreen.tsx': { effects: 1, why: 'One [] -deps read of the identity-protection mode, which cannot change while the screen is open.' },
})

// OUT_OF_ORDER must stay EMPTY: an effect that re-fires can have two reads in flight and the older
// can win — wrong data on screen. Allowlisting one would be a green test over a live defect.
export const outOfOrderAsyncEffects = Object.freeze({})

// Failure-path invariant for the renderer: a rejection there is the end of a user action or the
// read behind one, and swallowing it whole says nothing. The shapes core `no-empty` cannot see: a
// catch holding only a comment or a bare `return`, and a no-op handed to `.catch` or as the second
// argument of `.then` — an empty body, a bare `return`, `undefined`, `void 0`, or a function named as
// a no-op. A fallback VALUE (`() => null`, `() => []`) is a decision and stays legal. Exported so
// test/invariants/renderer-promise-lint.test.js parses the same grammar.
const swallowedMessage = 'This swallows a rejection whole. Report a user action through useRunAction (InlineError outside ToastProvider); a deliberate best-effort site goes in swallowedRejectionExemptions with its reason.'
const noopHandlers = [
  ":matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=0]",
  ":matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=1][body.body.0.type='ReturnStatement']:not([body.body.0.argument])",
  "ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
  "ArrowFunctionExpression[body.type='UnaryExpression'][body.operator='void'][body.argument.type='Literal']",
  'Identifier[name=/^_?(noop|ignore|swallow|nothing)$/i]',
]
export const swallowedRejectionRestrictions = [
  { selector: 'CatchClause > BlockStatement.body[body.length=0]', message: swallowedMessage },
  { selector: "CatchClause > BlockStatement.body[body.length=1][body.0.type='ReturnStatement']:not([body.0.argument])", message: swallowedMessage },
  ...noopHandlers.map((handler) => ({ selector: `CallExpression[callee.property.name='catch'] > ${handler}.arguments:nth-child(1)`, message: swallowedMessage })),
  ...noopHandlers.map((handler) => ({ selector: `CallExpression[callee.property.name='then'] > ${handler}.arguments:nth-child(2)`, message: swallowedMessage })),
]

// The sites above that are deliberate: no user is waiting on them, or a store already renders the
// failure. Each site is keyed by its enclosing scopes and code (test/helpers/lint-site-key.js), and
// the list is exact, so a new swallow in a listed file is caught as surely as one elsewhere.
export const swallowedRejectionExemptions = Object.freeze({
  'src/renderer/components/primitives/FilenameTitle.tsx': {
    why: 'Feature detection of canvas letterSpacing, which older engines reject; not a promise at all.',
    sites: [
      'FilenameTitle > useLayoutEffect > remeasure: try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacin',
    ],
  },
  'src/renderer/components/toast/bridges/JoinRequestToastBridge.tsx': {
    why: 'A background re-read that only dismisses stale join-request toasts; failing leaves them up.',
    sites: [
      'JoinRequestToastBridge > useEffect > unsubResolved > subscribe: request(\'space:pending-requests\', { spaceId: msg.spaceId }).then((result) => { c',
    ],
  },
  'src/renderer/hooks/useConnectionStatus.tsx': {
    why: 'Mount reads and liveness hints to the worker; status frames arrive by push and supersede them.',
    sites: [
      'ConnectionStatusProvider > useEffect > onChange: request(\'network:check-liveness\').catch(() => {})',
      'ConnectionStatusProvider > useEffect: request(\'network:check-liveness\').catch(() => {})',
      'ConnectionStatusProvider > useEffect: request(\'network:online-hint\', { online: osOnline }).catch(() => {})',
      'ConnectionStatusProvider > useEffect: request(\'network:status:get\') .then((data) => { if (cancelled) return // The swa',
      'ConnectionStatusProvider > useEffect: window.bridge.getNetOnline().then(setNetOnline).catch(() => {})',
    ],
  },
  'src/renderer/hooks/useDownloadRootStatus.ts': {
    why: 'A re-probe of download-root reachability through the query store, which renders the read error itself.',
    sites: [
      'useDownloadRootStatus > refresh > useCallback: refetchQuery<RootsStatus>(\'downloads:roots-status\', {}, null).catch(() => undefi',
    ],
  },
  'src/renderer/hooks/useFiles.ts': {
    why: 'Retry of the file list through the query store, which renders the read error itself.',
    sites: [
      'useFiles > refresh > useCallback: refetchQuery<FileEntry[]>(\'files:list\', { spaceId }, filesScopes(spaceId)).catch',
    ],
  },
  'src/renderer/hooks/useFolderMount.ts': {
    why: 'Cancelling a folder scan preview; the screen has already left the preview and ignores its result.',
    sites: [
      'cancelOwnedPreview: request(\'owned-folder:cancel-preview\', { previewId }).catch(() => undefined)',
    ],
  },
  'src/renderer/hooks/useForeignMount.ts': {
    why: 'Cancelling a mirror scan preview; the screen has already left the preview and ignores its result.',
    sites: [
      'cancelForeignPreview: request(\'foreign-folder:cancel-preview\', { previewId }).catch(() => undefined)',
    ],
  },
  'src/renderer/hooks/useIndexProgress.ts': {
    why: 'A seed read for the indexing notice; progress frames arrive by push and replace it.',
    sites: [
      'useIndexProgress > useEffect: request(\'owned-folder:index-status\', { spaceId, shareId }) // Narrowed to the tw',
    ],
  },
  'src/renderer/hooks/usePeerDownloadDetail.ts': {
    why: 'Subscribe seed read and unmount unsubscribe for serving detail; frames arrive by push.',
    sites: [
      'usePeerDownloadDetail > useEffect: request(\'serving:detail-subscribe\', { spaceId, path }).then((snap) => { if (!act',
      'usePeerDownloadDetail > useEffect: request(\'serving:detail-unsubscribe\', { spaceId, path }).catch(() => {})',
    ],
  },
  'src/renderer/hooks/usePeerDownloads.ts': {
    why: 'A seed read for peer download rows; progress frames arrive by push and replace it.',
    sites: [
      'usePeerDownloads > useEffect: request(\'serving:summary-list\', { spaceId }) .then((rows) => { if (!alive) retur',
    ],
  },
  'src/renderer/hooks/useSpaces.ts': {
    why: 'The re-reads after a space mutation; the mutation itself rejects to its caller and the store owns read errors.',
    sites: [
      'useSpaces > refresh: refetchQuery<Space[]>(\'spaces:list\', {}, SPACES_SCOPES).catch(() => {})',
      'useSpaces > refreshAfterDecision: fetchQuery(\'space:pending-requests\', { spaceId }).catch(() => {})',
    ],
  },
  'src/renderer/ipc/ipc.ts': {
    why: 'Tells the worker to stop a request nobody waits for any more; a late answer is dropped anyway.',
    sites: [
      'request > tellWorkerToStop: window.bridge.writeWorkerIPC(WORKER_SPEC, encoder.encode(frame)).catch(() => und',
    ],
  },
  'src/renderer/notifications/prefs.ts': {
    why: 'One-time migration of legacy localStorage prefs; unreadable legacy data is simply left behind.',
    sites: [
      'migrateLegacy: try { const raw = localStorage.getItem(LEGACY_STORAGE_KEY) if (raw === null) ret',
    ],
  },
  'src/renderer/platform/config-client.ts': {
    why: 'One-time migration of legacy localStorage keys; unreadable legacy data is simply left behind.',
    sites: [
      'migrateLegacyLocalStorage: try { const patch: RendererConfigPatch = {} const appearance: { theme?: ThemeMod',
    ],
  },
  'src/renderer/screens/AccountScreen.tsx': {
    why: 'A mount-time read of the identity-protection mode; on failure the row keeps its neutral state.',
    sites: [
      'DeviceGroup > useEffect: window.bridge.getIdentityProtection().then(setIdentity).catch(() => {})',
    ],
  },
  'src/renderer/screens/NetworkDiagnosticsScreen.tsx': {
    why: 'Unmount cleanup turning verbose logging back off; nobody is left on the screen to tell.',
    sites: [
      'NetworkDiagnosticsScreen > useEffect: request(\'setVerbose\', { verbose: false }).catch(() => {})',
      'NetworkDiagnosticsScreen > useEffect: window.bridge.setVerbose(false).catch(() => {})',
    ],
  },
  'src/renderer/screens/settings/ActivityLogSettings.tsx': {
    why: 'The re-read after a purge; the purge outcome is already reported and the store owns read errors.',
    sites: [
      'ActivityLogSettings > handlePurge > useCallback > runAction: refresh().catch(() => {})',
    ],
  },
  'src/renderer/shell/resume-screen.ts': {
    why: 'Remembering the screen to resume in sessionStorage; without storage the app boots at the root.',
    sites: [
      'rememberScreen: try { sessionStorage.setItem(KEY, screen) } catch { /* no resume, no harm */ }',
    ],
  },
  'src/renderer/store/query-store.js': {
    why: 'A hint-driven background refetch; the entry keeps the error and every subscribed screen renders it.',
    sites: [
      'refetch: fetchQuery(entry.type, entry.params ?? {}, entry.scopes).catch(() => {})',
    ],
  },
  'src/renderer/store/reconcile.ts': {
    why: 'A reconcile-driven re-read; the query entry keeps the error and the screen renders it.',
    sites: [
      'reread: refetchQuery(type, {}, scopes).catch(() => undefined)',
    ],
  },
  'src/renderer/store/useMainQuery.ts': {
    why: 'The mount read; the store keeps the error on the entry and the screen renders it.',
    sites: [
      'useMainQuery > useEffect: fetchMain(name).catch(() => {})',
    ],
  },
  'src/renderer/store/useQuery.ts': {
    why: 'The mount read; the store keeps the error on the entry and the screen renders it.',
    sites: [
      'useQuery > useEffect: fetchQuery<RequestResponse[K]>(type, params, scopes, opts).catch(() => {})',
    ],
  },
})

// Typed promise lint (`no-floating-promises` with ignoreVoid off, `no-misused-promises`) cannot tell
// a handler that reports its own failure from one that drops it. These sites are the first kind, or
// deliberate best-effort calls; the list is exact, keyed like the table above, and may only shrink.
export const promiseLintAllowlist = Object.freeze({
  'src/renderer/components/activity/ActivityFeed.tsx': {
    why: 'loadMore catches into the audit hook\'s error state, which the feed renders.',
    sites: [
      'no-floating-promises ActivityFeed > onClick: void loadMore()',
    ],
  },
  'src/renderer/components/modals/AddFolderShareModal.tsx': {
    why: 'wizard.next toasts its own failure; browse is the native picker.',
    sites: [
      'no-floating-promises AddFolderShareModal > onBrowse: void handleBrowse()',
      'no-floating-promises AddFolderShareModal > onNext: void wizard.next()',
    ],
  },
  'src/renderer/components/modals/AddRelayModal.tsx': {
    why: 'onAdd and parseRelayInput resolve to an error code the modal renders inline.',
    sites: [
      'no-misused-promises AddRelayModal > onClick: {handleAdd}',
      'no-misused-promises AddRelayModal > onClick: {handleContinue}',
      'no-misused-promises AddRelayModal > onConfirm: {decoded ? handleAdd : handleContinue}',
    ],
  },
  'src/renderer/components/modals/CreateSpaceModal.tsx': {
    why: 'handleCreate catches into the modal\'s inline error.',
    sites: [
      'no-misused-promises CreateSpaceModal > onClick: {handleCreate}',
    ],
  },
  'src/renderer/components/modals/EditFolderModal.tsx': {
    why: 'handleSave catches into the field errors; browse is the native picker.',
    sites: [
      'no-misused-promises EditFolderModal > onAction: {canRelocate ? handleBrowse : undefined}',
      'no-misused-promises EditFolderModal > onClick: {handleSave}',
      'no-misused-promises EditFolderModal > onConfirm: {handleSave}',
    ],
  },
  'src/renderer/components/modals/EditSpaceModal.tsx': {
    why: 'handleSave catches into the field errors; browse is the native picker.',
    sites: [
      'no-misused-promises EditSpaceModal > onAction: {handleBrowse}',
      'no-misused-promises EditSpaceModal > onClick: {handleSave}',
      'no-misused-promises EditSpaceModal > onConfirm: {handleSave}',
    ],
  },
  'src/renderer/components/modals/FeedbackModal.tsx': {
    why: 'handleSubmit catches into the modal\'s inline error.',
    sites: [
      'no-misused-promises FeedbackModal > onClick: {handleSubmit}',
    ],
  },
  'src/renderer/components/modals/InviteModal.tsx': {
    why: 'handleCreate catches into the modal\'s inline error.',
    sites: [
      'no-misused-promises InviteModal > onClick: {handleCreate}',
    ],
  },
  'src/renderer/components/modals/JoinSpaceModal.tsx': {
    why: 'handleJoin catches into the modal\'s inline error.',
    sites: [
      'no-misused-promises JoinSpaceModal > onClick: {handleJoin}',
      'no-misused-promises JoinSpaceModal > onConfirm: {handleJoin}',
    ],
  },
  'src/renderer/components/modals/LeaveSpaceModal.tsx': {
    why: 'handleLeave catches and toasts, then re-arms the dialog.',
    sites: [
      'no-misused-promises LeaveSpaceModal > onClick: {handleLeave}',
    ],
  },
  'src/renderer/components/modals/MirrorFolderModal.tsx': {
    why: 'wizard.next toasts its own failure; browse is the native picker.',
    sites: [
      'no-floating-promises MirrorFolderModal > onBrowse: void wizard.browse()',
      'no-floating-promises MirrorFolderModal > onNext: void wizard.next()',
    ],
  },
  'src/renderer/components/modals/RemoveFileModal.tsx': {
    why: 'handleRemove catches and toasts.',
    sites: [
      'no-floating-promises RemoveFileModal > onConfirm: void handleRemove()',
    ],
  },
  'src/renderer/components/modals/ScanPreviewModal.tsx': {
    why: 'onConfirm is the mount wizard\'s confirm, which toasts its own failure.',
    sites: [
      'no-misused-promises ScanPreviewModal > onClick: {handleConfirm}',
      'no-misused-promises ScanPreviewModal > onConfirm: {busy || overLimit ? undefined : handleConfirm}',
    ],
  },
  'src/renderer/components/primitives/FilenameTitle.tsx': {
    why: 'document.fonts.ready never rejects; it only triggers a remeasure.',
    sites: [
      'no-floating-promises FilenameTitle > useLayoutEffect: document.fonts?.ready.then(() => { if (!cancelled) remeasure() })',
    ],
  },
  'src/renderer/hooks/useAuditLog.ts': {
    why: 'reload catches into the hook\'s error state, which the log screen renders.',
    sites: [
      'no-floating-promises useAuditLog > useEffect > subscribe: void reload()',
      'no-floating-promises useAuditLog > useEffect: void reload()',
    ],
  },
  'src/renderer/hooks/usePendingSpaceAction.ts': {
    why: 'Native directory picker; main\'s handler rejects only if the OS dialog itself fails.',
    sites: [
      'no-floating-promises usePendingSpaceAction > openFolderPicker > useCallback: void window.bridge.browseShareFolder().then((picked) => { if (!picked || mounted',
    ],
  },
  'src/renderer/hooks/useShareActions.ts': {
    why: 'locate catches relocate failures into a toast; the picker before it rejects only if the OS dialog fails.',
    sites: [
      'no-floating-promises useShareActions > onStripAction > useCallback: void locate(share)',
    ],
  },
  'src/renderer/ipc/ipc.ts': {
    why: 'Scheduled worker respawn; spawnWorker catches a failed spawn and reschedules itself.',
    sites: [
      'no-floating-promises scheduleRespawn > setTimeout: void spawnWorker()',
    ],
  },
  'src/renderer/main.tsx': {
    why: 'Dev-only axe-core loader, which catches and warns inside its own IIFE.',
    sites: [
      'no-floating-promises (module): axe(React, ReactDOM, 1000)',
      'no-floating-promises (module): void (async () => { try { // axe-core/react instruments by overwriting React.cre',
    ],
  },
  'src/renderer/screens/FolderScreen.tsx': {
    why: 'locate catches relocate failures into a toast; the picker before it rejects only if the OS dialog fails.',
    sites: [
      'no-floating-promises FolderScreen > actions > onLocate: void locate(share)',
      'no-floating-promises FolderScreen > onLocate: void locate(share)',
    ],
  },
  'src/renderer/screens/NetworkDiagnosticsScreen.tsx': {
    why: 'run catches into the screen\'s status line.',
    sites: [
      'no-misused-promises NetworkDiagnosticsScreen > onClick: {() => run(\'preview\')}',
      'no-misused-promises NetworkDiagnosticsScreen > onClick: {() => run(\'save\')}',
    ],
  },
  'src/renderer/screens/OnboardingScreen.tsx': {
    why: 'handleContinue catches into the inline error; Onboarding renders outside ToastProvider.',
    sites: [
      'no-floating-promises OnboardingScreen > onClick: void handleContinue()',
      'no-floating-promises OnboardingScreen > onKeyDown: void handleContinue()',
    ],
  },
  'src/renderer/screens/SpaceScreen.tsx': {
    why: 'addFiles, approve, deny and approveMany toast their own failures; refresh goes through the store; locate as in FolderScreen.',
    sites: [
      'no-floating-promises SpaceScreen > listing > onRetry: void refresh()',
      'no-floating-promises SpaceScreen > onApproveMany: void handleApproveMany(keys)',
      'no-misused-promises SpaceScreen > onApprove: {handleApprove}',
      'no-misused-promises SpaceScreen > onDeny: {handleDeny}',
      'no-misused-promises SpaceScreen > onDeny: {handleDeny}',
      'no-misused-promises SpaceScreen > onFiles: addFiles',
      'no-misused-promises SpaceScreen > onFiles: {addFiles}',
      'no-misused-promises SpaceScreen > onFilesSelected: {addFiles}',
      'no-misused-promises SpaceScreen > onLocate: {locate}',
    ],
  },
  'src/renderer/screens/settings/ActivityLogSettings.tsx': {
    why: 'handleExport catches into the screen\'s status line.',
    sites: [
      'no-floating-promises ActivityLogSettings > onClick: void handleExport()',
    ],
  },
  'src/renderer/screens/settings/NetworkSettings.tsx': {
    why: 'apply catches both writes into the save-failed alert or the applies-after-restart note.',
    sites: [
      'no-floating-promises NetworkSettings > rowProps > onPreset: void apply({ ...current, [key]: next })',
      'no-floating-promises NetworkSettings > rowProps > onValue: void apply({ ...current, [key]: next })',
    ],
  },
  'src/renderer/screens/settings/StorageSettings.tsx': {
    why: 'handleBrowseFolder catches into the folder field\'s inline error.',
    sites: [
      'no-misused-promises StorageSettings > onAction: {handleBrowseFolder}',
    ],
  },
})

// Pure folder policy: these modules import no bare-* so they load under plain Node, where test/unit
// drives them. This list IS the statement — no file header repeats it. A module that needs bare-fs or
// bare-path belongs in the engine that calls the policy, not in the policy. Exported so
// test/invariants/folder-module-boundaries.test.js can check that each one really has a unit test.
// The same rule for transfer/: these import no bare-*, so a unit test can drive them under Node.
export const pureTransferModules = [
  'temp-paths',
  'bandwidth-limiter',
  'chunk-map-cache',
  'content-backends',
  'download-claim',
  'eta-estimator',
  'file-dedupe',
  'free-space',
  'list-deficits',
  'partial-suffix',
  'pending-transfers',
  'progress-ticker',
  'reveal-exit',
  'serve-ledger',
  'supersede-decision',
  'transfer-id',
  'transfer-status',
  'verified-copy',
]

// The pure half of network/ — the same rule, split from pureTransferModules when the folder was
// split, because the eslint block is keyed on the folder.
export const pureNetworkModules = [
  'admission-gates',
  'announce-ledger',
  'canary-probe',
  'content-peer-sockets',
  'content-swarm',
  'convergence-tick',
  'deferred-admission',
  'handshake-guard',
  'leave-protocol',
  'link-liveness',
  'member-reach',
  'net-impair',
  'network-status',
  'presence',
  'presence-broadcast',
  'relay',
  'relay-ticket',
  'support-bundle',
  'swarm-diagnostics',
  'swarm-registries',
]

export const pureFolderPolicyModules = [
  'echo-guard', 'mirror-budgets', 'mirror-loop', 'mirror-policy',
  'mount-fault', 'owned-policy', 'owned-state', 'path-keys', 'preview-tally',
  'publish-queue', 'publish-scheduler', 'retire-confirm', 'share-limits', 'watch-derive',
  'work-item',
]

// The pure half of spaces/ — the decision tables and the in-memory caches the record modules
// call. Each is loaded by test/unit under plain Node, which is what keeps the chain bare-free.
export const pureSpacesModules = [
  'creator-root', 'invites', 'join-requests', 'knock-policy', 'sck-seal', 'space-keys-codec',
  'membership/fold', 'membership/leave-state',
]

// The pure half of shares/ — the catalog key grammar and the listing fold, loaded by test/unit
// under plain Node.
export const pureSharesModules = ['catalog-keys', 'catalog-tally']
