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

// Failure-path invariant for screens, controls and hooks: a rejection there is the end of a user
// action or the read behind one, and swallowing it whole says nothing. Two shapes core `no-empty`
// cannot see: a catch whose block holds only a comment, and a `.catch` handed an empty function.
// Exported so test/invariants/renderer-promise-lint.test.js parses the same grammar.
const swallowedMessage = 'This swallows a rejection whole. Report a user action through useRunAction (InlineError outside ToastProvider); a deliberate best-effort site goes in swallowedRejectionExemptions with its reason.'
export const swallowedRejectionRestrictions = [
  { selector: 'CatchClause > BlockStatement.body[body.length=0]', message: swallowedMessage },
  {
    selector: "CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression).arguments[body.type='BlockStatement'][body.body.length=0]",
    message: swallowedMessage,
  },
]

// The sites above that are deliberate: no user is waiting on them, or a store already renders the
// failure. `sites` is exact, so a new swallow in a listed file is caught as surely as one elsewhere.
export const swallowedRejectionExemptions = Object.freeze({
  'src/renderer/screens/AccountScreen.tsx': { sites: 1, why: 'A mount-time read of the identity-protection mode; on failure the row keeps its neutral state.' },
  'src/renderer/screens/NetworkDiagnosticsScreen.tsx': { sites: 2, why: 'Unmount cleanup turning verbose logging back off; nobody is left on the screen to tell.' },
  'src/renderer/screens/settings/ActivityLogSettings.tsx': { sites: 1, why: 'The re-read after a purge; the purge outcome is already reported and the store owns read errors.' },
  'src/renderer/components/primitives/FilenameTitle.tsx': { sites: 1, why: 'Feature detection of canvas letterSpacing, which older engines reject; not a promise at all.' },
  'src/renderer/components/toast/bridges/JoinRequestToastBridge.tsx': { sites: 1, why: 'A background re-read that only dismisses stale join-request toasts; failing leaves them up.' },
  'src/renderer/hooks/useConnectionStatus.tsx': { sites: 5, why: 'Mount reads and liveness hints to the worker; status frames arrive by push and supersede them.' },
  'src/renderer/hooks/useFiles.ts': { sites: 1, why: 'Retry of the file list through the query store, which renders the read error itself.' },
  'src/renderer/hooks/useIndexProgress.ts': { sites: 1, why: 'A seed read for the indexing notice; progress frames arrive by push and replace it.' },
  'src/renderer/hooks/useMembershipRequests.ts': { sites: 1, why: 'Batch approval counts each failure and reports the batch once in a summary toast.' },
  'src/renderer/hooks/usePeerDownloadDetail.ts': { sites: 2, why: 'Subscribe seed read and unmount unsubscribe for serving detail; frames arrive by push.' },
  'src/renderer/hooks/usePeerDownloads.ts': { sites: 1, why: 'A seed read for peer download rows; progress frames arrive by push and replace it.' },
  'src/renderer/hooks/useSpaces.ts': { sites: 1, why: 'The re-read after a space mutation; the mutation itself rejects to its caller and the store owns read errors.' },
})

// Typed promise lint (`no-floating-promises` with ignoreVoid off, `no-misused-promises`) cannot tell
// a handler that reports its own failure from one that drops it. These files hold only the first
// kind, or deliberate best-effort calls; each count is exact and may only go down.
export const promiseLintAllowlist = Object.freeze({
  'src/renderer/app.tsx': { hits: 1, why: 'The boot What\'s New check; a changelog that cannot be read simply shows nothing.' },
  'src/renderer/main.tsx': { hits: 2, why: 'Dev-only axe-core loader, which catches and warns inside its own IIFE.' },
  'src/renderer/ipc/ipc.ts': { hits: 1, why: 'Scheduled worker respawn; spawnWorker catches a failed spawn and reschedules itself.' },
  'src/renderer/platform/config-client.ts': { hits: 1, why: 'Fire-and-forget persistence of renderer config; the in-memory cache already holds the value.' },
  'src/renderer/platform/i18n.ts': { hits: 3, why: 'i18next init, language switch and tray label push; all resolve locally or are cosmetic.' },
  'src/renderer/platform/theme.ts': { hits: 1, why: 'Tells main the theme for native chrome; cosmetic, the renderer already applied it.' },
  'src/renderer/platform/updates.ts': { hits: 1, why: 'Background update detection; a failed version read leaves the update state as it was.' },
  'src/renderer/platform/window-bounds.ts': { hits: 4, why: 'Best-effort window-bounds persistence on resize, blur, hide and unload.' },
  'src/renderer/notifications/click-router.ts': { hits: 4, why: 'Focus and reveal on an OS notification click; best-effort window management.' },
  'src/renderer/notifications/dispatcher.ts': { hits: 5, why: 'OS notifications; showing one is best-effort and the in-app state is the record.' },
  'src/renderer/hooks/useAppShellEffects.ts': { hits: 1, why: 'The one-time first-hide OS notification; best-effort.' },
  'src/renderer/hooks/useAuditLog.ts': { hits: 2, why: 'reload catches into the hook\'s error state, which the log screen renders.' },
  'src/renderer/hooks/usePendingSpaceAction.ts': { hits: 1, why: 'Native directory picker; main\'s handler rejects only if the OS dialog itself fails.' },
  'src/renderer/hooks/useShareActions.ts': { hits: 1, why: 'locate catches relocate failures into a toast; the picker before it rejects only if the OS dialog fails.' },
  'src/renderer/components/activity/ActivityFeed.tsx': { hits: 1, why: 'loadMore catches into the audit hook\'s error state, which the feed renders.' },
  'src/renderer/components/primitives/FilenameTitle.tsx': { hits: 1, why: 'document.fonts.ready never rejects; it only triggers a remeasure.' },
  'src/renderer/components/modals/AddFolderShareModal.tsx': { hits: 2, why: 'wizard.next toasts its own failure; browse is the native picker.' },
  'src/renderer/components/modals/AddRelayModal.tsx': { hits: 3, why: 'onAdd and parseRelayInput resolve to an error code the modal renders inline.' },
  'src/renderer/components/modals/CreateSpaceModal.tsx': { hits: 1, why: 'handleCreate catches into the modal\'s inline error.' },
  'src/renderer/components/modals/EditFolderModal.tsx': { hits: 3, why: 'handleSave catches into the field errors; browse is the native picker.' },
  'src/renderer/components/modals/EditSpaceModal.tsx': { hits: 3, why: 'handleSave catches into the field errors; browse is the native picker.' },
  'src/renderer/components/modals/FeedbackModal.tsx': { hits: 1, why: 'handleSubmit catches into the modal\'s inline error.' },
  'src/renderer/components/modals/InviteModal.tsx': { hits: 1, why: 'handleCreate catches into the modal\'s inline error.' },
  'src/renderer/components/modals/JoinSpaceModal.tsx': { hits: 2, why: 'handleJoin catches into the modal\'s inline error.' },
  'src/renderer/components/modals/LeaveSpaceModal.tsx': { hits: 1, why: 'handleLeave catches and toasts, then re-arms the dialog.' },
  'src/renderer/components/modals/MirrorFolderModal.tsx': { hits: 2, why: 'wizard.next toasts its own failure; browse is the native picker.' },
  'src/renderer/components/modals/RemoveFileModal.tsx': { hits: 1, why: 'handleRemove catches and toasts.' },
  'src/renderer/components/modals/ScanPreviewModal.tsx': { hits: 2, why: 'onConfirm is the mount wizard\'s confirm, which toasts its own failure.' },
  'src/renderer/screens/ConnectionProblemScreen.tsx': { hits: 1, why: 'probeCanary resolves null on failure and the verdict stays as it was.' },
  'src/renderer/screens/FolderScreen.tsx': { hits: 2, why: 'locate catches relocate failures into a toast; the picker before it rejects only if the OS dialog fails.' },
  'src/renderer/screens/NetworkDiagnosticsScreen.tsx': { hits: 2, why: 'run catches into the screen\'s status line.' },
  'src/renderer/screens/OnboardingScreen.tsx': { hits: 2, why: 'handleContinue catches into the inline error; Onboarding renders outside ToastProvider.' },
  'src/renderer/screens/SpaceScreen.tsx': { hits: 9, why: 'addFiles, approve, deny and approveMany toast their own failures; refresh goes through the store; locate as in FolderScreen.' },
  'src/renderer/screens/settings/ActivityLogSettings.tsx': { hits: 1, why: 'handleExport catches into the screen\'s status line.' },
  'src/renderer/screens/settings/NetworkSettings.tsx': { hits: 2, why: 'apply catches both writes into the save-failed alert or the applies-after-restart note.' },
  'src/renderer/screens/settings/StorageSettings.tsx': { hits: 1, why: 'handleBrowseFolder catches into the folder field\'s inline error.' },
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
  'publish-queue', 'publish-scheduler', 'retire-confirm', 'share-limits', 'work-item',
]

// The pure half of spaces/ — the decision tables and the in-memory caches the record modules
// call. Each is loaded by test/unit under plain Node, which is what keeps the chain bare-free.
export const pureSpacesModules = [
  'creator-root', 'invites', 'join-requests', 'knock-policy', 'sck-seal',
  'membership/fold', 'membership/leave-state',
]

// The pure half of shares/ — the catalog key grammar and the listing fold, loaded by test/unit
// under plain Node.
export const pureSharesModules = ['catalog-keys', 'catalog-tally']
