import test from 'brittle'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')

// `.claude/` prose names full `src/…` paths, and a path that no longer exists sends a reader to a
// file that is not there. Only full paths are held: a bare filename is often a deliberate mention
// of something since deleted, a full path never is.
const DOCS = readdirSync(path.join(root, '.claude')).filter((f) => f.endsWith('.md'))

test('every src path the .claude docs name exists', (t) => {
  const missing = []
  for (const doc of DOCS) {
    const text = readFileSync(path.join(root, '.claude', doc), 'utf8')
    for (const m of text.matchAll(/`(src\/[^`\s]+\.(?:js|ts|tsx|cjs|mjs|json|css))`/g)) {
      if (/[*?[\]{}]/.test(m[1])) continue
      if (!existsSync(path.join(root, m[1]))) missing.push(`${doc}: ${m[1]}`)
    }
  }
  t.alike(missing.sort(), [], 'docs name source files that do not exist')
})
