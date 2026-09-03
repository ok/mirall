import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'
import { chokidarSingleOwnerRestrictions } from '../../eslint.config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const mainDir = path.join(here, '..', '..', 'src', 'main')
const OWNER = path.join(mainDir, 'watch-host.js')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

function verify (linter, source, filename) {
  return linter.verify(source, {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs' },
    rules: { 'no-restricted-syntax': ['error', ...chokidarSingleOwnerRestrictions] },
  }, filename)
}

// REGRESSION (FIX-PI3-3: two modules each required chokidar and each learned its lessons alone.
// The owned-folder watcher polled network mounts and cut off an error storm; the loose-file
// watcher did neither, so a file on a network volume stopped re-publishing in silence. Extracting
// watch-host.js fixes today's divergence; this rule is what stops the NEXT watcher re-learning it
// wrong — a third `require('chokidar')` cannot reach main without failing lint.)
test('REGRESSION (FIX-PI3-3): src/main/watch-host.js is the only module that loads chokidar', (t) => {
  const linter = new Linter()

  // The grammar itself, on fixtures: what must be caught, and what must stay legal.
  t.ok(verify(linter, "const chokidar = require('chokidar')\n", 'control.js').length > 0, 'a bare require is caught')
  t.ok(verify(linter, "const { watch } = require('chokidar')\n", 'control2.js').length > 0, 'a destructured require is caught')
  t.ok(verify(linter, "require('chokidar').watch('/x')\n", 'control3.js').length > 0, 'an inline require is caught')
  t.ok(verify(linter, "import chokidar from 'chokidar'\n", 'control4.js').length > 0, 'an ESM import is caught')
  t.alike(verify(linter, "const { createWatchHost } = require('./watch-host.js')\n", 'ok.js'), [], 'the host is the supported door')
  t.alike(verify(linter, "const chokidarish = require('chokidar-cli')\n", 'ok2.js'), [], 'a different package stays legal')

  const files = walk(mainDir).filter((f) => f !== OWNER)
  t.ok(files.length > 0, 'src/main was actually walked')
  for (const file of files) {
    t.alike(verify(linter, readFileSync(file, 'utf8'), file).map((m) => `${m.line}: ${m.message}`), [], path.relative(process.cwd(), file))
  }
  t.ok(/require\('chokidar'\)/.test(readFileSync(OWNER, 'utf8')), 'and watch-host.js is where chokidar actually lives')
})
