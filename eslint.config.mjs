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
// quoted/computed-key bypass. Exported so test/invariants/renderer-status-invariant.test.js parses the same
// grammar. Rationale: .claude/testing.md, "Lint invariants".
import {
  rendererStatusRestrictions,
  moduleLevelTimerRestrictions,
  moduleScopeTimerHandleRestrictions,
  chokidarSingleOwnerRestrictions,
  rendererContractOnlyImports,
  byteFormatterSingleOwnerRestrictions,
  unmountOnlyAsyncEffects,
  outOfOrderAsyncEffects,
  swallowedRejectionRestrictions,
  swallowedRejectionExemptions,
  promiseLintAllowlist,
  pureTransferModules,
  pureNetworkModules,
  pureFolderPolicyModules,
  pureSpacesModules,
  pureSharesModules,
} from './eslint-rules/invariants.mjs'

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
      parserOptions: { ecmaFeatures: { jsx: true }, projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, __DEV__: 'readonly' },
    },
    plugins: { 'jsx-a11y': jsxA11y, '@typescript-eslint': tseslint.plugin, local: { rules: { 'no-unguarded-async-effect': noUnguardedAsyncEffect } } },
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
      // A promise nobody handles is a failure nobody hears; `void` is a way of saying so, not a handler.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
      ...complexityBudget,
      ...whitespace,
    },
  },

  // A screen or a control never swallows a failure: an empty catch there is a click that did
  // nothing and said nothing. Rationale: .claude/testing.md, "Lint invariants".
  {
    files: ['src/renderer/screens/**/*.tsx', 'src/renderer/components/**/*.tsx'],
    rules: { 'no-empty': ['error', { allowEmptyCatch: false }] },
  },

  // See swallowedRejectionRestrictions. The block repeats the renderer's other selectors because a
  // later no-restricted-syntax replaces an earlier one rather than adding to it.
  {
    files: ['src/renderer/{screens,components,hooks}/**/*.{ts,tsx,js}'],
    rules: { 'no-restricted-syntax': ['error', ...rendererStatusRestrictions, ...byteFormatterSingleOwnerRestrictions, ...swallowedRejectionRestrictions] },
  },
  {
    files: Object.keys(swallowedRejectionExemptions),
    rules: { 'no-restricted-syntax': ['error', ...rendererStatusRestrictions, ...byteFormatterSingleOwnerRestrictions] },
  },

  // Exact per-file counts live in promiseLintAllowlist and are held by
  // test/invariants/renderer-promise-lint.test.js, which lints with no allowances.
  {
    files: Object.keys(promiseLintAllowlist),
    rules: { '@typescript-eslint/no-floating-promises': 'off', '@typescript-eslint/no-misused-promises': 'off' },
  },

  // Data layer — Bare worker + shared modules (ESM).
  {
    files: ['src/shared/**/*.js', 'src/worker/**/*.js'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      // `crypto` is turned OFF deliberately. In this codebase the name means hypercore-crypto, an
      // explicit import, but Node and Bare both expose a WebCrypto global under it — so a module
      // that loses its import still passes no-undef and fails at the first call instead. Every
      // consumer imports it; nothing here wants the global.
      globals: { ...globals.node, Bare: 'readonly', Pear: 'readonly', crypto: 'off' },
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

  // The pure half of spaces/ — see pureSpacesModules.
  {
    files: pureSpacesModules.map((name) => `src/shared/spaces/${name}.js`),
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['bare-*'], message: 'This module is pure so test/unit loads it under Node — do the I/O in the engine that calls it.' }],
      }],
    },
  },

  // The pure half of shares/ — see pureSharesModules.
  {
    files: pureSharesModules.map((name) => `src/shared/shares/${name}.js`),
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['bare-*'], message: 'This module is pure so test/unit loads it under Node — do the I/O in the engine that calls it.' }],
      }],
    },
  },

  // The pure half of network/ — see pureNetworkModules.
  {
    files: pureNetworkModules.map((name) => `src/shared/network/${name}.js`),
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['bare-*'], message: 'This module is pure so test/unit loads it under Node — do the I/O in the engine that calls it.' }],
      }],
    },
  },

  // The pure half of transfer/ — see pureTransferModules.
  {
    files: pureTransferModules.map((name) => `src/shared/transfer/${name}.js`),
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['bare-*'], message: 'This module is pure so test/unit loads it under Node — do the I/O in the engine that calls it.' }],
      }],
    },
  },

  // Electron main — host process (CommonJS). Node globals only: main is not a browser context, and
  // spreading the browser set here would resolve `crypto`, `fetch` and `localStorage` to globals
  // that do not exist, hiding a require this process actually needs. no-undef is the gate that
  // catches an identifier a refactor left behind — there is no typechecker over src/main.
  {
    files: ['src/main/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, crypto: 'off' },
    },
    rules: {
      ...unusedVars,
      ...complexityBudget,
      ...whitespace,
      'no-undef': 'error',
      'no-restricted-syntax': ['error', ...chokidarSingleOwnerRestrictions],
    },
  },

  // Preload — CommonJS like main, but it runs in the renderer's context and reaches window.
  {
    files: ['src/preload/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...unusedVars,
      ...complexityBudget,
      ...whitespace,
      'no-undef': 'error',
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
    files: ['src/renderer/format/bytes.js'],
    rules: { 'no-restricted-syntax': ['error', ...rendererStatusRestrictions] },
  },

  // Harness and tooling. Neither tree is typechecked, so an identifier left behind by a refactor
  // surfaces only when the code runs — which for a test helper means a wrong failure symptom rather
  // than an error. The a11y, boundary and lifecycle invariants are deliberately absent: they are
  // statements about shipped code, and a fixture exists to violate them.
  {
    files: ['test/**/*.{js,mjs}', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2025,
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
