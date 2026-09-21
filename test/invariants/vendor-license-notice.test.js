import test from 'brittle'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const VENDOR = path.join(root, 'src/shared/transfer/backends/overlay/vendor')

// Upstream tests ported alongside the vendored source, by their path upstream.
const PORTED_TESTS = new Map([
  ['test/unit/overlay-vendor-chunker.test.js', 'test/chunker.test.js'],
  ['test/unit/overlay-vendor-messages-v2.test.js', 'test/messages-v2.test.js'],
  ['test/integration/overlay-vendor-helpers.js', 'test/helpers.js'],
  ['test/integration/overlay-vendor-restart-durability.test.js', 'test/overlay-v2-restart-durability.test.js'],
  ['test/integration/overlay-vendor-transfer.test.js', 'test/transfer.test.js'],
])

const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const provenance = () => read(path.join(VENDOR, 'PROVENANCE.md'))

// The snapshot every header names is the one PROVENANCE.md records, so a re-vendor that moves the
// pin cannot leave the headers naming the old one.
function snapshot() {
  const m = provenance().match(/Snapshot copied from commit:\*\* `([0-9a-f]{7})[0-9a-f]*` \((v[\d.]+)\)/)
  return m ? `${m[1]} (${m[2]})` : null
}

// Every file derived from upstream is modified upstream code, and the AGPL asks each one to say so:
// where it came from, under what license, and that we changed it and when. A re-vendor or a
// wholesale file swap drops that header first and nothing else notices. It names its own upstream
// file, so a header pasted into the wrong module fails here, and it ends at the first blank line,
// which is where PROVENANCE.md's re-diff recipe stops stripping.
const expectedHeader = (upstream, pointer) => [
  '// SPDX-License-Identifier: AGPL-3.0-only',
  `// Derived from hyper-overlay ${upstream} @ ${snapshot()}, Copyright (C) 2026 the`,
  ...pointer,
].join('\n') + '\n\n'

const SOURCE_POINTER = [
  '// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md',
  '// lists the changes and carries the full license notice.',
]
const TEST_POINTER = [
  "// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; the vendored",
  "// overlay's PROVENANCE.md carries the full license notice.",
]

test('the guard is looking at the vendored overlay and its recorded snapshot', (t) => {
  t.ok(existsSync(path.join(VENDOR, 'overlay-v2.js')), 'vendor/ still holds the overlay facade — a moved folder must move this guard')
  t.ok(snapshot(), 'PROVENANCE.md still records the snapshot commit and version')
})

test('every vendored file opens with its license and modification notice', (t) => {
  const vendored = readdirSync(VENDOR).filter((name) => name.endsWith('.js'))
  const wrong = vendored.filter((name) => !read(path.join(VENDOR, name)).startsWith(expectedHeader(`lib/${name}`, SOURCE_POINTER)))
  t.alike(wrong, [], 'vendored files missing the header block (see PROVENANCE.md → License)')
})

test('every ported upstream test opens with the same notice', (t) => {
  const wrong = [...PORTED_TESTS].filter(([file, upstream]) => !read(path.join(root, file)).startsWith(expectedHeader(upstream, TEST_POINTER)))
  t.alike(wrong.map(([file]) => file), [], 'ported tests missing the header block')
})

test('PROVENANCE.md carries the license section the headers point at', (t) => {
  const section = provenance().split(/^## License$/m)[1]?.split(/^## /m)[0] ?? ''
  t.ok(section, 'PROVENANCE.md has a "## License" section')
  t.ok(section.includes('AGPL-3.0-only'), 'and it names the license the headers carry')
})
