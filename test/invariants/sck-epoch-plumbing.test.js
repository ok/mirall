import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const srcDir = path.join(root, 'src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) }
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(root, p)
// Code only: comment lines are dropped before matching, so a doc mention is never a reader.
const codeOf = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const filesMatching = (re) => walk(srcDir).filter((f) => re.test(codeOf(f))).map(rel).sort()

// `sckDerivable` carries two meanings on an older record — "I created this space" and "the key
// can be re-derived" — and after a rotation the second stops being true even for the creator. The
// split field `createdBySelf` is the one the data layer reads; the older marker is read in exactly
// one place, the compatibility fallback in `isCreatedBySelf`, and written in one, so a downgrade
// still finds it. A third site is the overloaded meaning coming back.
test('sckDerivable is read only by the compatibility fallback and written only by createSpace', (t) => {
  const writers = filesMatching(/sckDerivable: true/)
  t.alike(writers, ['src/shared/spaces/space-lifecycle.js'], 'the one writer')
  const readers = walk(srcDir).filter((f) => /\bsckDerivable\b/.test(codeOf(f).replace(/sckDerivable: true/g, ''))).map(rel).sort()
  t.alike(readers, ['src/shared/spaces/space.js'], 'the one reader')
  t.ok(/\.sckDerivable\b/.test(codeOf(path.join(srcDir, 'shared/spaces/space.js'))), 'the fallback still reads it')
})

// Every peer-catalog read goes through resolvePeerCatalog, which is where the record's epoch
// picks the key. The only other replicated core opened under an SCK is the legacy peer-drive
// purge, which clears cores it never decrypts. A third site is a reader that breaks on the first
// rotation.
test('a replicated core is opened under an SCK in exactly two places', (t) => {
  const offenders = filesMatching(/(getStore\(\)\.get\(\{ key:|new Hyperdrive\(getStore\(\), )[^\n]*encryptionKey/)
  t.alike(offenders, ['src/shared/shares/peer-catalog.js', 'src/shared/storage/migrations/legacy-peer-cache.js'])
  t.ok(/getSpaceContentKeyForEpoch\(/.test(codeOf(path.join(srcDir, 'shared/shares/peer-catalog.js'))), 'and the catalog read picks the key by epoch')
})

// The renderer never sees a catalog-key field: the epoch is stripped with the two keys it belongs
// beside, by the one projection every roster payload runs through.
test('the roster projection strips looseCatalogEpoch with its siblings', (t) => {
  const src = readFileSync(path.join(srcDir, 'worker/space-projection.js'), 'utf8')
  t.ok(/stripCatalogKeys\(\{ looseCatalogKey, looseCatalogKeyEnc, looseCatalogEpoch, \.\.\.m \}\)/.test(src))
})
