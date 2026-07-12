import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { PARTIAL_SUFFIX, partialPathFor } from '../../src/shared/transfer/partial-suffix.js'
import { DEFAULT_IGNORE, shouldIgnore } from '../../src/shared/folders/path-keys.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

test('the partial suffix ends in .part but carries an ownership token', (t) => {
  t.ok(PARTIAL_SUFFIX.endsWith('.part'), 'ends in .part')
  t.not(PARTIAL_SUFFIX, '.part', 'never a bare .part — that would collide with Firefox/KDE downloads')
})

test('partialPathFor appends the suffix to the target path', (t) => {
  t.is(partialPathFor('/dl/movie.mp4'), '/dl/movie.mp4' + PARTIAL_SUFFIX)
  t.is(partialPathFor('/dl/no-ext'), '/dl/no-ext' + PARTIAL_SUFFIX)
})

test('DEFAULT_IGNORE excludes our partials, at the root and nested', (t) => {
  t.ok(shouldIgnore('movie.mp4' + PARTIAL_SUFFIX, DEFAULT_IGNORE), 'root-level partial ignored')
  t.ok(shouldIgnore('a/b/movie.mp4' + PARTIAL_SUFFIX, DEFAULT_IGNORE), 'nested partial ignored')
})

// A third-party partial (IE/Edge `.partial`, Firefox/KDE `.part`) is a real file the user
// may well want published. Only OUR token is excluded — a broad `*.part` glob would
// silently drop legitimate files out of an owned folder.
test('DEFAULT_IGNORE does not swallow files that merely look partial', (t) => {
  t.absent(shouldIgnore('notes.part', DEFAULT_IGNORE), 'a third-party .part is not ignored')
  t.absent(shouldIgnore('legacy.txt.partial', DEFAULT_IGNORE), 'a third-party .partial is not ignored')
  t.absent(shouldIgnore('report.mirall.partner', DEFAULT_IGNORE), 'a near-miss name is not ignored')
})

// The vendored engine keeps its own PARTIAL_SUFFIX/partialPathFor as a standalone default,
// but they are free of instance config: importing them while the app injects a different
// suffix would silently desync the writer from the sweep. App code reads partial-suffix.js.
test('no app module imports the suffix helpers out of the vendored engine', (t) => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor') walk(full)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      const src = fs.readFileSync(full, 'utf8')
      for (const m of src.matchAll(/import\s*{([^}]*)}\s*from\s*['"]([^'"]*vendor\/transfer\.js)['"]/g)) {
        const named = m[1]
        if (/\bPARTIAL_SUFFIX\b|\bpartialPathFor\b/.test(named)) offenders.push(path.relative(SRC, full))
      }
    }
  }
  walk(SRC)
  t.alike(offenders, [], 'PARTIAL_SUFFIX / partialPathFor are never imported from vendor/transfer.js')
})
