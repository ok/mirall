import test from 'brittle'
import { execFileSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { readFileSync } from 'fs'
import { CASES } from '../frontend-layout/cases.mjs'
import { htmlNameFor } from '../frontend-layout/build.mjs'
import { createRequire } from 'module'

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend-layout')

// The manifest is the index. A row with no entry file is a harness that silently never builds; an
// entry file with no row is one nothing can run. Both were possible while 19 HTML files, 19 build
// blocks and 18 npm scripts were maintained by hand.
test('every manifest case has an entry file and a runner', (t) => {
  for (const c of CASES) {
    const entry = c.name === 'harness' ? 'harness-entry.tsx' : `harness-${c.name}-entry.tsx`
    const runner = c.name === 'harness' ? 'run.mjs' : `run-${c.name}.mjs`
    t.ok(existsSync(path.join(HERE, entry)), `${entry} exists`)
    t.ok(existsSync(path.join(HERE, runner)), `${runner} exists`)
  }
})

test('every entry file has a manifest row', (t) => {
  const named = new Set(CASES.map((c) => c.name))
  const orphans = readdirSync(HERE)
    .filter((f) => /^harness(-.*)?-entry\.tsx$/.test(f))
    .map((f) => (f === 'harness-entry.tsx' ? 'harness' : f.replace(/^harness-(.*)-entry\.tsx$/, '$1')))
    .filter((n) => !named.has(n))
  t.alike(orphans.sort(), [], 'entry files with no cases.mjs row')
})

// The HTML is generated into this folder and gitignored; a committed copy would drift from the
// template and is how a harness stops linking the real stylesheet without anyone noticing.
test('no harness HTML is committed', (t) => {
  const tracked = execFileSync('git', ['ls-files', 'test/frontend-layout'], { encoding: 'utf8' })
  t.alike(tracked.split('\n').filter((f) => /harness.*\.html$/.test(f)), [], 'harness HTML is generated, not committed')
})

// The runner and the README documented `test:layout:case` while package.json did not define it —
// a script lost in a rebase reads as "documented but unwired", which is the class this file exists
// to close.
test('the case runner is reachable from package.json', (t) => {
  const pkg = createRequire(import.meta.url)('../../package.json')
  t.ok(pkg.scripts['test:layout:case'], 'npm run test:layout:case is defined')
  t.ok(existsSync(path.join(HERE, 'run-case.mjs')), 'run-case.mjs exists')
})

// The link the generation actually broke: the runner names an HTML file by string, and the
// generator renamed the default case's output from harness.html to harness-harness.html. Every
// other check here passed while `npm run test:layout` could not load its page at all.
test('every runner names an HTML file the generator emits', (t) => {
  const emitted = new Set(CASES.map((c) => htmlNameFor(c.name)))
  for (const c of CASES) {
    const runner = c.name === 'harness' ? 'run.mjs' : `run-${c.name}.mjs`
    const src = readFileSync(path.join(HERE, runner), 'utf8')
    const named = src.match(/html:\s*'([^']+)'/)
    if (!named) continue
    t.ok(emitted.has(named[1]), `${runner} loads ${named[1]}, which build.mjs writes`)
  }
})
