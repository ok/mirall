import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'
import { watcherSingleOwnerRestrictions } from '../../eslint-rules/invariants.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(here, '..', '..', 'src')
const OWNER = path.join(srcDir, 'worker', 'watchers', 'watch-host.js')
// The trees that load modules from disk: the host's CommonJS and the back end's ESM.
const TREES = [['main', 'commonjs'], ['worker', 'module'], ['shared', 'module']]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

function verify(linter, source, filename, sourceType = 'commonjs') {
  return linter.verify(source, {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2025, sourceType },
    rules: { 'no-restricted-syntax': ['error', ...watcherSingleOwnerRestrictions] },
  }, filename)
}

// REGRESSION (FIX-PI3-3: two modules each required chokidar and each learned its lessons alone.
// The owned-folder watcher polled network mounts and cut off an error storm; the loose-file
// watcher did neither, so a file on a network volume stopped re-publishing in silence. Extracting
// watch-host.js fixes today's divergence; this rule is what stops the NEXT watcher re-learning it
// wrong — a third load of the watcher package cannot reach src/ without failing lint.)
test('REGRESSION (FIX-PI3-3): src/worker/watchers/watch-host.js is the only module that loads the file watcher', (t) => {
  const linter = new Linter()

  // The grammar itself, on fixtures: what must be caught, and what must stay legal.
  t.ok(verify(linter, "const watcher = require('chokidar4bare')\n", 'control.js').length > 0, 'a bare require is caught')
  t.ok(verify(linter, "const { watch } = require('chokidar4bare')\n", 'control2.js').length > 0, 'a destructured require is caught')
  t.ok(verify(linter, "require('chokidar4bare').watch('/x')\n", 'control3.js').length > 0, 'an inline require is caught')
  t.ok(verify(linter, "import watcher from 'chokidar4bare'\n", 'control4.js', 'module').length > 0, 'an ESM import is caught')
  t.ok(verify(linter, "const chokidar = require('chokidar')\n", 'control5.js').length > 0, 'upstream chokidar is caught too')
  t.ok(verify(linter, "import chokidar from 'chokidar'\n", 'control6.js', 'module').length > 0, 'and its ESM import')
  t.alike(verify(linter, "import { createWatchHost } from './watch-host.js'\n", 'ok.js', 'module'), [], 'the host is the supported door')
  t.alike(verify(linter, "const chokidarish = require('chokidar-cli')\n", 'ok2.js'), [], 'a different package stays legal')

  for (const [tree, sourceType] of TREES) {
    const files = walk(path.join(srcDir, tree)).filter((f) => f !== OWNER)
    t.ok(files.length > 0, 'src/' + tree + ' was actually walked')
    for (const file of files) {
      t.alike(verify(linter, readFileSync(file, 'utf8'), file, sourceType).map((m) => `${m.line}: ${m.message}`), [], path.relative(process.cwd(), file))
    }
  }
  t.ok(/from 'chokidar4bare'/.test(readFileSync(OWNER, 'utf8')), 'and watch-host.js is where the watcher actually lives')
})
