import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { CASES } from './cases.mjs'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '../..')

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  define: { __DEV__: 'false' },
  loader: { '.png': 'file', '.jpg': 'file', '.svg': 'file' },
  logLevel: 'info',
}

const entryFor = (name) => (name === 'harness' ? 'harness-entry.tsx' : `harness-${name}-entry.tsx`)
const bundleFor = (name) => (name === 'harness' ? 'harness.js' : `harness-${name}.js`)

// Generated, not committed: the 19 files this replaced differed only in <title> and the bundle src,
// and a hand-maintained copy is where a harness silently stops linking the real stylesheet.
export function htmlFor({ name, title, cfg, note = "The REAL built stylesheet, so the harness uses the app's actual CSS." }) {
  const cfgBlock = cfg
    ? `  <!-- One pending request + a delayed approve reply so the in-flight disable is observable. -->\n  <script>\n    window.__HARNESS_CFG = {\n${cfg}\n    }\n  </script>\n`
    : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <!-- ${note} -->
  <link rel="stylesheet" href="../../assets/dist/app.css" />
${cfgBlock}  <!-- Classic script: installs window.bridge BEFORE the ESM bundle imports ipc.ts. -->
  <script src="./fake-bridge.js"></script>
</head>
<body style="background: var(--color-background);">
  <div id="root"></div>
  <script type="module" src="./dist/${bundleFor(name)}"></script>
</body>
</html>
`
}

if (import.meta.filename === process.argv[1]) {
  // Always rebuild the real app stylesheet (the harness links assets/dist/app.css):
  // Tailwind only emits classes it saw at build time, so a stale app.css silently
  // drops any class a source edit just introduced and the harness measures a lie.
  execFileSync('npm', ['run', 'build:css'], { cwd: REPO, stdio: 'inherit' })
  await Promise.all(CASES.map((c) => build({
    ...common,
    entryPoints: [path.join(HERE, entryFor(c.name))],
    outfile: path.join(HERE, 'dist', bundleFor(c.name)),
  })))
  for (const c of CASES) writeFileSync(path.join(HERE, `harness-${c.name}.html`), htmlFor(c))
  console.error('[build] harness bundled')
}
