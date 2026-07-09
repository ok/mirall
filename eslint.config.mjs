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
    rules: { ...unusedVars, ...complexityBudget },
  },

  // Electron main + preload — host process (CommonJS).
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { ...unusedVars, ...complexityBudget },
  },
]
