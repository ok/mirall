import test from 'brittle'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENGINE = path.join(root, 'src/shared/transfer/backends/overlay/engine')

// Every engine file that derives from upstream, mapped to the upstream file it came from. A file born
// in this repository has no row and carries no upstream header. When a derived file is split, each
// part keeps its origin's row: code moved out of an AGPL-3.0-only file stays derived.
const DERIVED = new Map([
  ['chunk-scheduler.js', 'lib/chunk-scheduler.js'],
  ['chunker.js', 'lib/chunker.js'],
  ['file-index.js', 'lib/file-index.js'],
  ['messages-v2.js', 'lib/messages-v2.js'],
  ['overlay-v2.js', 'lib/overlay-v2.js'],
  ['protocol-v2.js', 'lib/protocol-v2.js'],
  ['transfer.js', 'lib/transfer.js'],
])

// Upstream tests ported alongside the engine source, by their path upstream.
const PORTED_TESTS = new Map([
  ['test/unit/overlay-engine-chunker.test.js', 'test/chunker.test.js'],
  ['test/unit/overlay-engine-messages-v2.test.js', 'test/messages-v2.test.js'],
  ['test/integration/overlay-engine-helpers.js', 'test/helpers.js'],
  ['test/integration/overlay-engine-transfer.test.js', 'test/transfer.test.js'],
])

const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const provenance = () => read(path.join(ENGINE, 'PROVENANCE.md'))

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

test('the guard is looking at the overlay engine and its recorded snapshot', (t) => {
  t.ok(existsSync(path.join(ENGINE, 'overlay-v2.js')), 'engine/ still holds the overlay facade — a moved folder must move this guard')
  t.ok(snapshot(), 'PROVENANCE.md still records the snapshot commit and version')
})

test('every file derived from upstream opens with its license and modification notice', (t) => {
  const wrong = [...DERIVED].filter(([file, upstream]) => !existsSync(path.join(ENGINE, file)) || !read(path.join(ENGINE, file)).startsWith(expectedHeader(upstream, SOURCE_POINTER)))
  t.alike(wrong.map(([file]) => file), [], 'derived files missing the header block (see PROVENANCE.md → License)')
})

test('no first-party engine file claims an upstream origin', (t) => {
  const own = readdirSync(ENGINE, { recursive: true }).filter((name) => name.endsWith('.js') && !DERIVED.has(name))
  t.alike(own.filter((name) => read(path.join(ENGINE, name)).includes('Derived from hyper-overlay')), [])
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
