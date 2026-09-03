import tseslint from 'typescript-eslint'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import globals from 'globals'

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
// reach it. Every periodic or deferred call belongs inside a Subsystem's _open, armed through
// `this.timers`, so it dies with the subsystem. Exported so
// test/unit/module-level-timers.test.js enforces the same grammar through eslint's parser.
export const moduleLevelTimerRestrictions = [{
  // `:not(:function *)` alone is the whole rule: it matches a set*() call that has no function
  // ancestor, i.e. one that runs at import. Scoping it to top-level statement types instead would
  // miss every nesting a module-level timer can hide in — a top-level `if`, `try`, bare block,
  // labelled block, `for`/`while`, `switch` case, or a class static field or static block.
  selector: "CallExpression[callee.name=/^set(Interval|Timeout)$/]:not(:function *)",
  message: 'No module-level timers — arm it in a Subsystem _open so close() can clear it.',
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
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      'jsx-a11y/no-autofocus': 'off',
      'jsx-a11y/label-has-associated-control': ['error', { depth: 3 }],
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'region'] }],
      'no-restricted-syntax': ['error', ...rendererStatusRestrictions],
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
]
