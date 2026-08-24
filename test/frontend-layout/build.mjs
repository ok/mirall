import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '../..')

// Always rebuild the real app stylesheet (the harness links assets/dist/app.css):
// Tailwind only emits classes it saw at build time, so a stale app.css silently
// drops any class a source edit just introduced and the harness measures a lie.
execFileSync('npm', ['run', 'build:css'], { cwd: REPO, stdio: 'inherit' })

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  define: { __DEV__: 'false' },
  loader: { '.png': 'file', '.jpg': 'file', '.svg': 'file' },
  logLevel: 'info',
}

await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-members-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-members.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-approval-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-approval.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-dropoverlay-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-dropoverlay.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-sharecard-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-sharecard.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-progress-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-progress.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-peerdownload-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-peerdownload.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-filecard-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-filecard.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-modaltitle-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-modaltitle.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-logohover-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-logohover.js'),
})
await build({
  ...common,
  entryPoints: [path.join(HERE, 'harness-mirrorers-entry.tsx')],
  outfile: path.join(HERE, 'dist/harness-mirrorers.js'),
})
console.error('[build] harness bundled')
