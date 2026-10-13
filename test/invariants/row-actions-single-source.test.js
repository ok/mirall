import test from 'brittle'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'

// Every file-row button comes from one table (model/file-row-action.js), through one renderer
// (ActionLane), in one row (FileRow) — the action-side twin of row-view-single-source. A third row
// hand-rolling a "Download" button would put a second answer on screen for the same file.
const root = new URL('../../', import.meta.url)
const abs = (p) => fileURLToPath(new URL(p, root))
// Comments say nothing about what the code does, so every check reads the code without them.
// `://` is kept so a URL in a string is not mistaken for a comment.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (p) => stripComments(readFileSync(abs(p), 'utf8'))

const MODEL = 'model/file-row-action.js'
const LANE = 'components/cards/ActionLane.tsx'
const ROW = 'components/cards/FileRow.tsx'
const ACTION_KEYS = [
  'file.revealInFolder', 'file.unshare', 'file.download', 'file.downloadUnavailable', 'file.pause',
  'file.cancel', 'file.resume', 'file.discardPartial', 'file.retry', 'file.dismiss',
]

const rendererSources = (dir = 'src/renderer') => {
  const out = []
  for (const entry of readdirSync(abs(dir), { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...rendererSources(p))
    else if (/\.(js|ts|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}
const sources = rendererSources().map((p) => ({ rel: p.slice('src/renderer/'.length), src: read(p) }))

test('only ActionLane imports the action table', (t) => {
  const importers = sources.filter((f) => /from '[./]*\/?model\/file-row-action\.js'|from '\.\/file-row-action\.js'/.test(f.src)).map((f) => f.rel)
  t.alike(importers, [LANE])
})

test('only FileRow mounts ActionLane', (t) => {
  t.alike(sources.filter((f) => /<ActionLane\b/.test(f.src)).map((f) => f.rel), [ROW])
})

test('FileRow renders no button of its own, and ActionLane decides nothing by status', (t) => {
  const row = read(`src/renderer/${ROW}`)
  t.absent(/<button\b|<IconButton\b/.test(row), 'FileRow has no button or IconButton')
  t.absent(/\.status\s*[!=]==|case '/.test(read(`src/renderer/${LANE}`)), 'ActionLane compares no status')
})

test('the action labels appear only in the table', (t) => {
  for (const key of ACTION_KEYS) {
    const quoted = ["'", '"', '`'].map((q) => q + key + q)
    const users = sources.filter((f) => quoted.some((q) => f.src.includes(q))).map((f) => f.rel)
    t.alike(users, [MODEL], `${key} is named only by ${MODEL}`)
  }
})

test('the guard is not vacuous', (t) => {
  const model = read(`src/renderer/${MODEL}`)
  for (const key of ACTION_KEYS) t.ok(model.includes(`'${key}'`), `the table names ${key}`)
  t.ok(read(`src/renderer/${LANE}`).includes('fileRowActions('), 'ActionLane calls fileRowActions')
  for (const gone of ['FileCard.tsx', 'ShareFileRow.tsx']) {
    t.absent(existsSync(abs(`src/renderer/components/cards/${gone}`)), `components/cards/${gone} is gone`)
  }
})
