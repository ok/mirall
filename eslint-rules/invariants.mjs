// The invariant tables the flat config applies and ten guard tests read back. They live here rather
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
