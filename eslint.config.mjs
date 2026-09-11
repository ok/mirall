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

// Whitespace, applied to every source area. These are ERRORS, not warnings: each one is fully
// autofixable, so a violation costs a --fix rather than a judgement call, and the warning ceiling in
// lint:ci stays a measure of complexity debt alone.
const whitespace = {
  indent: ['error', 2, { SwitchCase: 1 }],
  'space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
  'no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
}

// Unused-symbol hygiene for the (previously unlinted) data layer. Warn-level and lenient on
// args/rest-siblings so it flags genuinely-dead locals, not deliberate signature shapes.
const unusedVars = {
  'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
}

// EDA invariant: event handlers decorate rows, never construct row STATUS (worker-derived per read).
// Scoped to ObjectExpression so destructured reads stay legal; the second selector closes the
// quoted/computed-key bypass. Exported so test/unit/renderer-status-invariant.test.js parses the same
// grammar. Rationale: .claude/testing.md, "Lint invariants".
const statusMessage = 'Do not construct row status in an event handler — status is worker-derived (level-triggered). Decorate instead.'
export const rendererStatusRestrictions = [
  { selector: "CallExpression[callee.name='subscribe'] ObjectExpression > Property[key.name='status']", message: statusMessage },
  { selector: "CallExpression[callee.name='subscribe'] ObjectExpression > Property[key.value='status']", message: statusMessage },
]

// Lifecycle invariant, import-time corner only: a timer armed at module level runs at import, so no
// close() can reach it. The broad property (every periodic call dies with its subsystem) is not
// decidable statically; test/integration/timer-lifecycle.test.js measures it at runtime. Exported so
// test/unit/module-level-timers.test.js parses the same grammar.
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
// test/unit/watch-host-single-owner.test.js parses the same grammar.
const chokidarMessage = 'Only src/main/watch-host.js may load chokidar — arm the watch through createWatchHost so network polling, the error-storm cut-off and the option bag stay in one place.'
export const chokidarSingleOwnerRestrictions = [
  { selector: "CallExpression[callee.name='require'][arguments.0.value='chokidar']", message: chokidarMessage },
  { selector: "ImportDeclaration[source.value='chokidar']", message: chokidarMessage },
]

// Boundary invariant: the renderer may import the contract package and nothing else under
// src/shared/. The data layer imports bare-*, Hyper* and Node modules the sandboxed renderer cannot
// bundle, and every renderer "twin" this codebase has deleted began as an import that was not
// allowed and a copy that was. The re-export shims that used to stand in for this rule are gone;
// the rule is what replaces them. Exported so test/unit/renderer-contract-only-imports.test.js
// enforces the same grammar through eslint's parser.
export const rendererContractOnlyImports = [{
  regex: '(^|/)shared/(?!contract/)',
  message: 'The renderer may import src/shared/contract/** and nothing else under src/shared/ — move the rule into the contract package or ask the worker over IPC.',
}]

// Presentation invariant: one byte size means one string. src/renderer/formatSize.js owns the decimal
// ladder because the divisor and the labels must agree; a unit-ladder array literal is the shape a
// re-implementation always takes, whatever it is named. Exported so
// test/unit/byte-formatter-single-owner.test.js parses the same grammar.
const byteLadderMessage = 'Only src/renderer/formatSize.js may declare a byte-unit ladder — call formatSize so the divisor and the labels stay in one place.'
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
  'src/renderer/screens/Account.tsx': { effects: 1, why: 'One [] -deps read of the identity-protection mode, which cannot change while the screen is open.' },
})

// OUT_OF_ORDER must stay EMPTY: an effect that re-fires can have two reads in flight and the older
// can win — wrong data on screen. Allowlisting one would be a green test over a live defect.
export const outOfOrderAsyncEffects = Object.freeze({})

// Pure folder policy: these modules import no bare-* so they load under plain Node, where test/unit
// drives them. This list IS the statement — no file header repeats it. A module that needs bare-fs or
// bare-path belongs in the engine that calls the policy, not in the policy. Exported so
// test/unit/folder-module-boundaries.test.js can check that each one really has a unit test.
export const pureFolderPolicyModules = [
  'echo-guard', 'fetch-attempts', 'integrity-seen', 'mirror-health', 'mirror-loop', 'mirror-ownership',
  'mirror-reach', 'mirror-walk', 'mount-fault', 'path-keys', 'preview-detail', 'preview-tally',
  'publish-queue', 'publish-scheduler', 'share-limits', 'temp-paths', 'work-item',
]

export default [
  // Vendored hyper-overlay v2 subset — third-party code kept re-diffable
  // against upstream (PROVENANCE.md), so our complexity/style rules don't apply.
  // Both dist trees are generated bundles: assets/dist is the app's, test/frontend-layout/dist is
// whatever the layout harnesses last built. Neither is source, and linting a 2MB bundle drowns the
// run in tens of thousands of findings.
{ ignores: ['assets/dist/**', 'test/frontend-layout/dist/**', 'node_modules/**', 'src/shared/transfer/backends/overlay/vendor/**'] },

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
      'no-restricted-imports': ['error', { patterns: rendererContractOnlyImports }],
      'local/no-unguarded-async-effect': ['error', {
        allow: [...Object.keys(unmountOnlyAsyncEffects), ...Object.keys(outOfOrderAsyncEffects)],
      }],
      ...complexityBudget,
      ...whitespace,
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
      // The data layer has no typechecker over it (tsconfig covers src/renderer only), so an
      // identifier left behind by a refactor surfaces only as a swallowed runtime warning.
      'no-undef': 'error',
      ...unusedVars,
      ...complexityBudget,
      ...whitespace,
      'no-restricted-syntax': ['error', ...moduleLevelTimerRestrictions, ...moduleScopeTimerHandleRestrictions],
    },
  },

  // The pure half of folders/ — see pureFolderPolicyModules.
  {
    files: pureFolderPolicyModules.map((name) => `src/shared/folders/${name}.js`),
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['bare-*'], message: 'This module is pure so test/unit loads it under Node — do the I/O in the engine that calls it.' }],
      }],
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
      ...whitespace,
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

  // Harness and tooling. Neither tree is typechecked, so an identifier left behind by a refactor
  // surfaces only when the code runs — which for a test helper means a wrong failure symptom rather
  // than an error. The a11y, boundary and lifecycle invariants are deliberately absent: they are
  // statements about shipped code, and a fixture exists to violate them.
  {
    files: ['test/**/*.{js,mjs}', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, Bare: 'readonly', Pear: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      ...unusedVars,
      ...whitespace,
    },
  },

  // The renderer fixture: it runs inside the packaged harness page, not under Node.
  {
    files: ['test/frontend-layout/fake-bridge.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
]
