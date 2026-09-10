import test from 'brittle'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(here, '..', '..', 'scripts', 'check-comment-hygiene.sh')

// The gate cds to its own parent's parent, so the copy sits under <tmp>/scripts/ and the fake tree
// under <tmp>/src/ — the same shape it scans in the repo. One file per violation class, so a class
// the gate stops seeing fails by name.
function tree (t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'comment-hygiene-'))
  t.teardown(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'scripts'))
  copyFileSync(SCRIPT, path.join(root, 'scripts', 'check-comment-hygiene.sh'))
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, 'src', rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

function run (root, args = []) {
  const r = spawnSync('bash', [path.join(root, 'scripts', 'check-comment-hygiene.sh'), ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

const CLEAN = '// The rule, stated in the present tense.\nexport const x = 1\n'

test('every blocking class is reported by name and by site, and the tree exits 1', (t) => {
  const root = tree(t, {
    'a/alnum-id.js': '// see FIX-BW9 for the stall retry\nexport const a = 1\n',
    'a/plan-ref.js': '// the format is frozen by plans/foo.md\nexport const b = 1\n',
    'a/claude-ref.js': '// see .claude/design.md for the table\nexport const c = 1\n',
    'a/section-cite.ts': '// per §4 of the design doc\nexport const d = 1\n',
    'a/issue-ref.tsx': '// fixed in #123\nexport const e = 1\n',
    'a/styles.css': '/* pinned by the contrast test (FIX-6) */\n:root { --x: 1; }\n',
    'a/clean.js': CLEAN
  })
  const { code, out } = run(root)
  t.is(code, 1, 'a tree with findings exits 1')
  t.ok(/BLOCKING: internal audit\/fix identifiers/.test(out), 'alphanumeric ids are a blocking class')
  t.ok(out.includes('alnum-id.js:1:'), 'FIX-BW9 is reported with its site')
  t.ok(out.includes('styles.css:1:'), 'a .css comment carrying FIX-6 is scanned')
  t.ok(/BLOCKING: references to \.claude\/ or plan docs/.test(out), 'planning-doc references are a blocking class')
  t.ok(out.includes('plan-ref.js:1:'), 'plans/<name>.md is reported')
  t.ok(out.includes('claude-ref.js:1:'), '.claude/ is reported')
  t.ok(/BLOCKING: section cites/.test(out), 'section cites are a blocking class')
  t.ok(out.includes('section-cite.ts:1:'), '§ outside vendor/ is reported')
  t.ok(/BLOCKING: issue\/PR number references/.test(out), 'issue numbers are a blocking class')
  t.ok(out.includes('issue-ref.tsx:1:'), '#123 in a comment is reported')
  t.absent(out.includes('clean.js'), 'a clean file is never named')
})

test('the vendored subset may carry its own markers', (t) => {
  const root = tree(t, {
    'shared/transfer/backends/overlay/vendor/chunk-scheduler.js': '// [mirall] FIX-BW9 — keep-alive budget, per §4.6\nexport const v = 1\n',
    'a/clean.js': CLEAN
  })
  const { code, out } = run(root)
  t.is(code, 0, 'vendor/ ids and § cites do not block')
  t.ok(out.includes('comment-hygiene: clean.'), 'and the tree reports clean')
})

test('PROVENANCE.md is the one .md the gate reads, for planning-doc references', (t) => {
  const root = tree(t, {
    'shared/transfer/backends/overlay/vendor/PROVENANCE.md': '- item (plan: `.claude/tasks/plan-x.md`)\n',
    'a/clean.js': CLEAN
  })
  const { code, out } = run(root)
  t.is(code, 1, 'a .claude/ reference in PROVENANCE.md blocks')
  t.ok(out.includes('PROVENANCE.md:1:'), 'and is reported with its site')
})

test('a clean tree exits 0', (t) => {
  const root = tree(t, {
    'a/clean.js': CLEAN,
    'b/clean.css': '/* The groove token sits outside the surface ramp. */\n',
    'shared/transfer/backends/overlay/vendor/PROVENANCE.md': '- item, per .claude/solution-architecture.md\n'
  })
  const { code, out } = run(root)
  t.is(code, 0)
  t.ok(out.includes('comment-hygiene: clean.'))
})

test('history narration warns and never changes the exit code', (t) => {
  const root = tree(t, {
    'a/narrative.js': '// this used to be two maps; the hand-rolled version slipped\nexport const n = 1\n',
    'a/narrative.css': '/* despite the legacy name it is opaque */\n'
  })
  const { code, out } = run(root)
  t.is(code, 0, 'warnings alone exit 0')
  t.ok(/WARNING \(review, non-blocking\): history narration/.test(out), 'the warning section prints')
  t.ok(out.includes('narrative.js:1:'), 'the js site is listed')
  t.ok(out.includes('narrative.css:1:'), 'the css site is listed')
})

test('there is no --strict switch to forget', (t) => {
  const root = tree(t, { 'a/issue-ref.js': '// see #4242\n' })
  t.is(run(root, ['--strict']).code, 1, 'an extra argument changes nothing')
  t.is(run(root).code, 1, 'findings exit 1 unconditionally')
})
