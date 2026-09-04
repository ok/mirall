import tseslint from 'typescript-eslint'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import globals from 'globals'
import noUnguardedAsyncEffect from './eslint-rules/no-unguarded-async-effect.js'

// Complexity/size budget applied to every source area. These are WARNINGS, not errors: they
// surface the existing hotspots (see the Stage-1 worklist) and flag any NEW oversized function
// in review, without turning CI red on pre-existing debt. Ratchet the thresholds down as the
// worst offenders get refactored.
const complexityBudget = {
  complexity: ['warn', 20],
  'max-depth': ['warn', 4],
  'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
}

// Unused-symbol hygiene for the (previously unlinted) data layer. Warn-level and lenient on
// args/rest-siblings so it flags genuinely-dead locals, not deliberate signature shapes.
const unusedVars = {
  'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
}

// EDA invariant: renderer event handlers decorate rows (progress/verifyFraction), they never
// construct row STATUS — status is worker-derived per read (level-triggered). Scoped to
// ObjectExpression so destructured READS of a payload's status field stay legal; the second
// selector closes the quoted/computed-key bypass. Exported so
// test/unit/renderer-status-invariant.test.js enforces the same grammar through eslint's parser.
const statusMessage = 'Do not construct row status in an event handler — status is worker-derived (level-triggered). Decorate instead.'
export const rendererStatusRestrictions = [
  { selector: "CallExpression[callee.name='subscribe'] ObjectExpression > Property[key.name='status']", message: statusMessage },
  { selector: "CallExpression[callee.name='subscribe'] ObjectExpression > Property[key.value='status']", message: statusMessage },
]

// Lifecycle invariant: a timer armed at module level runs at import, so no close() can ever
// reach it. Exported so test/unit/module-level-timers.test.js enforces the same grammar through
// eslint's parser.
//
// This is the import-time corner of the lifecycle rule, and only that. The message used to say
// "arm it in a Subsystem _open so close() can clear it", which reads as a promise that every
// periodic call dies with its subsystem — a property no selector can decide, since three of the
// eleven module-scoped handles in the data layer belong to module singletons that are not
// Subsystems at all. The broad property is measured where it is actually observable: at runtime, in
// test/integration/timer-lifecycle.test.js, with test/unit/module-scoped-timer-handles.test.js as
// the decidable static companion.
export const moduleLevelTimerRestrictions = [{
  // `:not(:function *)` alone is the whole rule: it matches a set*() call that has no function
  // ancestor, i.e. one that runs at import. Scoping it to top-level statement types instead would
  // miss every nesting a module-level timer can hide in — a top-level `if`, `try`, bare block,
  // labelled block, `for`/`while`, `switch` case, or a class static field or static block.
  selector: "CallExpression[callee.name=/^set(Interval|Timeout)$/]:not(:function *)",
  message: 'No timer armed at import — nothing can clear it. Arm it inside a Subsystem _open through this.timers, or inside a function whose module holds a matching clear.',
}]

// Mechanism invariant: chokidar's options are per-INSTANCE, not per-path, and its sharp edges —
// native events never reach a network mount, an erroring watcher spins forever — were learned
// once on the owned-folder watcher and never carried to the loose-file watcher, so a file shared
// from /Volumes, /mnt, /media or a UNC path silently stopped re-publishing. src/main/watch-host.js
// is now the single owner of every chokidar decision; a second `require('chokidar')` is exactly how
// that divergence would come back. Exported so test/unit/watch-host-single-owner.test.js enforces
// the same grammar through eslint's parser.
const chokidarMessage = 'Only src/main/watch-host.js may load chokidar — arm the watch through createWatchHost so network polling, the error-storm cut-off and the option bag stay in one place.'
export const chokidarSingleOwnerRestrictions = [
  { selector: "CallExpression[callee.name='require'][arguments.0.value='chokidar']", message: chokidarMessage },
  { selector: "ImportDeclaration[source.value='chokidar']", message: chokidarMessage },
]

// Presentation invariant: one byte size means one string. src/renderer/formatSize.js owns the
// decimal (SI) ladder because the divisor and the labels have to agree — a binary 1024 divisor
// under KB/MB/GB labels reads ~7-10% below what the OS shows for the same file. auditRow.js grew a
// second ladder that did exactly that, so the Activity Log printed every size ~7.4% low while
// every other screen printed it right, and a unit test pinned the wrong numbers. A unit-ladder
// array literal is the shape a re-implementation always takes; naming the array differently
// changes nothing here. Exported so test/unit/byte-formatter-single-owner.test.js enforces the
// same grammar through eslint's parser.
const byteLadderMessage = 'Only src/renderer/formatSize.js may declare a byte-unit ladder — call formatSize so the divisor and the labels stay in one place.'
export const byteFormatterSingleOwnerRestrictions = ['KB', 'MB', 'GB', 'TB', 'KiB', 'MiB', 'GiB', 'TiB'].map((unit) => ({
  selector: `ArrayExpression > Literal[value='${unit}']`,
  message: byteLadderMessage,
}))

// Stale-response invariant, split into two tables because the two cases are not the same risk and
// must not share a number. The predecessor guard grepped for `let cancelled = false` and counted
// four files: it missed six hand-rolled guards spelled `alive`/`active`/`sawFrame`/`runRef`, and —
// the point — it could never see an effect with no guard at all, which is the only thing actually
// forbidden. Six such effects were live while it reported the property covered.
//
// UNMOUNT_ONLY: the effect has [] deps and one in-flight read, so nothing can supersede it — the
// only race is a write after unmount, which React tolerates.
export const unmountOnlyAsyncEffects = Object.freeze({
  'src/renderer/hooks/useProfile.ts': { effects: 1, why: 'One [] -deps read of the local profile; the live value afterwards arrives on event:profile-needed, not on a re-read.' },
  'src/renderer/hooks/useConnectionStatus.tsx': { effects: 1, why: 'The net.online probe has [] deps and one read; transitions arrive on onNetOnlineChange. (The other effect in this file carries a cleanup flag and is not exempt.)' },
  'src/renderer/screens/Account.tsx': { effects: 1, why: 'One [] -deps read of the identity-protection mode, which cannot change while the screen is open.' },
})

// OUT_OF_ORDER must stay EMPTY. An effect that re-fires — on a dep change or from a subscription —
// can have two reads in flight, and the older one can win. That is wrong data on screen, not a
// warning in a console. Allowlisting one of these would repeat the mistake this whole guard exists
// to undo: a green test standing over a live defect.
export const outOfOrderAsyncEffects = Object.freeze({})

export default [
  // Vendored hyper-overlay v2 subset — third-party code kept re-diffable
  // against upstream (PROVENANCE.md), so our complexity/style rules don't apply.
  { ignores: ['assets/dist/**', 'node_modules/**', 'src/shared/transfer/backends/overlay/vendor/**'] },

  // Renderer — sandboxed React UI. Accessibility rules stay ERRORS (the a11y gate); complexity
  // is advisory on top.
  {
    files: ['src/renderer/**/*.{ts,tsx,js}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, __DEV__: 'readonly' },
    },
    plugins: { 'jsx-a11y': jsxA11y, local: { rules: { 'no-unguarded-async-effect': noUnguardedAsyncEffect } } },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      'jsx-a11y/no-autofocus': 'off',
      'jsx-a11y/label-has-associated-control': ['error', { depth: 3 }],
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'region'] }],
      'no-restricted-syntax': ['error', ...rendererStatusRestrictions, ...byteFormatterSingleOwnerRestrictions],
      'local/no-unguarded-async-effect': ['error', {
        allow: [...Object.keys(unmountOnlyAsyncEffects), ...Object.keys(outOfOrderAsyncEffects)],
      }],
      ...complexityBudget,
    },
  },

  // Data layer — Bare worker + shared modules (ESM).
  {
    files: ['src/shared/**/*.js', 'src/worker/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, Bare: 'readonly', Pear: 'readonly' },
    },
    rules: {
      // The data layer has no typechecker over it — tsconfig only includes src/renderer — so an
      // identifier left behind by a refactor resolves to nothing and surfaces only as a swallowed
      // runtime warning. Two such bugs shipped green through every gate before this was turned on.
      'no-undef': 'error',
      ...unusedVars,
      ...complexityBudget,
      'no-restricted-syntax': ['error', ...moduleLevelTimerRestrictions],
    },
  },

  // Electron main + preload — host process (CommonJS).
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...unusedVars,
      ...complexityBudget,
      'no-restricted-syntax': ['error', ...chokidarSingleOwnerRestrictions],
    },
  },

  // The one module the rule above exists to protect.
  {
    files: ['src/main/watch-host.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // The one module the byte-ladder rule exists to protect. The renderer's status invariant still
  // applies to it, so only the ladder restriction is dropped.
  {
    files: ['src/renderer/formatSize.js'],
    rules: { 'no-restricted-syntax': ['error', ...rendererStatusRestrictions] },
  },
]
