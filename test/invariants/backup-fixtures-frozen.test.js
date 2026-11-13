import test from 'brittle'
import { createHash } from 'crypto'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// The backup fixtures are written once, by the release each directory names, and never again: their
// bytes are not reproducible (a random repository key and nonces), so the recorded sums are the
// only proof a fixture is still what that release wrote. A new release adds a directory and its
// lines; nothing else here changes.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = path.join(ROOT, 'test/fixtures/backup')
const BOOKKEEPING = new Set(['SHA256SUMS', 'SOURCES.md'])

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const full = path.join(dir, entry)
  return statSync(full).isDirectory() ? walk(full) : [full]
})

const recorded = new Map(readFileSync(path.join(FIXTURES, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => {
  const [sum, file] = line.split(/\s+\*?/, 2)
  return [file, sum]
}))

const onDisk = walk(FIXTURES).map((file) => path.relative(FIXTURES, file).split(path.sep).join('/')).filter((file) => !BOOKKEEPING.has(file))

const sha256 = (file) => createHash('sha256').update(readFileSync(path.join(FIXTURES, file))).digest('hex')

test('every backup fixture file is byte-for-byte what its release wrote', (t) => {
  t.ok(recorded.size > 0, 'sums are recorded')
  const changed = onDisk.filter((file) => recorded.has(file) && recorded.get(file) !== sha256(file))
  t.alike(changed, [], 'no fixture file was edited or regenerated')
})

test('the backup fixtures hold exactly the recorded files', (t) => {
  const present = new Set(onDisk)
  t.alike(onDisk.filter((file) => !recorded.has(file)).sort(), [], 'no file without a recorded sum')
  t.alike([...recorded.keys()].filter((file) => !present.has(file)).sort(), [], 'no recorded file missing')
})

test('every backup fixture release has its provenance row', (t) => {
  const sources = readFileSync(path.join(FIXTURES, 'SOURCES.md'), 'utf8')
  const releases = readdirSync(FIXTURES).filter((name) => statSync(path.join(FIXTURES, name)).isDirectory())
  t.ok(releases.length > 0)
  t.alike(releases.filter((release) => !sources.includes(`| ${release} | v${release} |`)), [], 'SOURCES.md names every release directory')
})
