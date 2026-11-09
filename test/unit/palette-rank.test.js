import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'keyboard', 'registry.ts')
const { code } = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' })
const mod = { exports: {} }
new Function('module', 'exports', code)(mod, mod.exports)
const { paletteRank } = mod.exports

test('a search word finds a command its label does not name', (t) => {
  t.ok(paletteRank('Open Appearance Settings', 'theme dark mode', 'dark mode') > 0)
  t.ok(paletteRank('Open Appearance Settings', 'theme dark mode', 'Theme') > 0, 'case-insensitive')
  t.is(paletteRank('Open Appearance Settings', 'theme dark mode', 'printer'), 0)
  t.is(paletteRank('Open Appearance Settings', '', 'dark'), 0, 'no search words, no match beyond the label')
})

test('any match on the label outranks a match on search words', (t) => {
  const byLabel = paletteRank('Open Network Diagnostics', '', 'diag')
  const byWord = paletteRank('Open Network Status', 'diagnostics', 'diag')
  t.ok(byLabel > byWord, `${byLabel} > ${byWord}`)
  t.ok(paletteRank('Show Connection History', '', 'tion') > paletteRank('Open Network Status', 'connection', 'tion'))
})

test('the label ranks exact, then prefix, then word start, then anywhere', (t) => {
  const label = 'Open Activity Log'
  const ranks = ['open activity log', 'open', 'log', 'pen'].map((q) => paletteRank(label, '', q))
  t.alike([...ranks].sort((a, b) => b - a), ranks, ranks.join(' > '))
  t.ok(ranks[3] > 0)
})

test('an empty query lists every command', (t) => {
  t.is(paletteRank('Open Settings', '', '   '), 1)
})
