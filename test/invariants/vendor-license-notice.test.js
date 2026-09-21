import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const VENDOR = path.join(root, 'src/shared/transfer/backends/overlay/vendor')

// Every vendored file is modified upstream code, and the AGPL asks each one to say so: where it came
// from, under what license, and that we changed it and when. A re-vendor or a wholesale file swap
// drops that header first and nothing else notices. The header is everything above the first blank
// line, so PROVENANCE.md's re-diff recipe strips it with `sed '1,/^$/d'`; it names its own file so a
// header pasted into the wrong module fails here.
const expectedHeader = (name) => [
  '// SPDX-License-Identifier: AGPL-3.0-only',
  `// Derived from hyper-overlay lib/${name} @ 6cac8ee (v0.2.9), Copyright (C) 2026 the`,
  '// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026: each change',
  '// is marked [mirall] and listed in PROVENANCE.md, which carries the full license notice.',
].join('\n')

const vendored = readdirSync(VENDOR).filter((name) => name.endsWith('.js')).sort()

test('the vendor folder is where this guard looks', (t) => {
  t.ok(vendored.includes('overlay-v2.js'), 'vendor/ still holds the overlay facade — a moved folder must move this guard')
})

test('every vendored file opens with its license and modification notice', (t) => {
  const wrong = vendored.filter((name) => {
    const src = readFileSync(path.join(VENDOR, name), 'utf8')
    return src.split('\n\n')[0] !== expectedHeader(name)
  })
  t.alike(wrong, [], 'vendored files missing the header block (see PROVENANCE.md → License)')
})

test('PROVENANCE.md carries the license section the headers point at', (t) => {
  const provenance = readFileSync(path.join(VENDOR, 'PROVENANCE.md'), 'utf8')
  t.ok(/^## License$/m.test(provenance), 'PROVENANCE.md has a "## License" section')
  t.ok(provenance.includes('AGPL-3.0-only'), 'the License section names the license the headers carry')
})
