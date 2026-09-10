import test from 'brittle'
import b4a from 'b4a'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prefixRange } from '../../src/shared/core/bee-keys.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// A bee keyed `utf-8` compares keys as UTF-8 bytes, so the property that matters is a BYTE
// property: every key under the prefix must sort below the bound, and the first key outside
// the prefix must not.
const below = (a, b) => b4a.compare(b4a.from(a, 'utf-8'), b4a.from(b, 'utf-8')) < 0

// REGRESSION (FIX-BEEKEY-1: prefix scans were bounded with `prefix + '\xff'`. U+00FF encodes to
// C3 BF, so a suffix starting at U+0100 or above — ł, Cyrillic, CJK, emoji — has a lead byte
// above the bound and was silently dropped from the scan.)
test('REGRESSION (FIX-BEEKEY-1): the upper bound covers suffixes above U+00FF', (t) => {
  const prefix = 'file/share-x/'
  const { gte, lt } = prefixRange(prefix)
  t.is(gte, prefix, 'lower bound is the prefix itself')

  for (const name of ['a.txt', 'zz.txt', 'ÿ.txt', 'Łódź.pdf', 'Отчёты/x.txt', '日本語.txt', '😀.png', '\u{10FFFF}']) {
    t.ok(below(prefix + name, lt), 'covered: ' + name)
  }
  t.ok(below(prefix + '\xff', lt), 'a suffix that IS the old sentinel stays inside the range')
})

test('the upper bound excludes the next namespace', (t) => {
  const { lt } = prefixRange('file/share-x/')
  t.absent(below('file/share-x0', lt), 'the byte after the separator is outside')
  t.absent(below('file/share-xy/a.txt', lt), 'a longer sibling share id is outside')
  t.ok(below('file/share-x/', lt), 'the bare prefix key is inside')
})

test('bounds each separator the data layer uses', (t) => {
  t.alike(prefixRange('intent/'), { gte: 'intent/', lt: 'intent0' })
  t.alike(prefixRange('verified:s1:sh|'), { gte: 'verified:s1:sh|', lt: 'verified:s1:sh}' })
  t.alike(prefixRange('tree:'), { gte: 'tree:', lt: 'tree;' })
})

// The bound is only sound while the final character is one ASCII code point; a non-ASCII
// terminator would need a byte-level carry. Failing loud beats returning a bound that
// silently truncates the scan — the exact failure this module exists to remove.
test('rejects a prefix it cannot bound soundly', (t) => {
  for (const bad of ['', 'file/ł', 'x😀', null, undefined, 42]) {
    t.exception(() => prefixRange(bad), 'rejects ' + JSON.stringify(bad))
  }
})

// The sentinel idiom this module replaces reads as correct and fails silently — a scan that
// truncates mid-range returns a short list, never an error. Nothing but this gate stops a new
// range scan from reintroducing it, so the bound stays greppable: a literal high character
// appended to a prefix in an `lt:`/`lte:` bound is the shape that must not come back.
test('no bee range bound reintroduces a high-character sentinel', (t) => {
  const root = path.join(here, '..', '..', 'src')
  const files = spawnSync('git', ['ls-files', '-z', root], { encoding: 'utf-8' })
    .stdout.split('\0').filter((f) => f.endsWith('.js'))
  t.ok(files.length > 100, 'the sweep found the source tree (' + files.length + ' files)')

  const offenders = []
  for (const file of files) {
    if (file.endsWith('src/shared/core/bee-keys.js')) continue
    const body = readFileSync(path.join(here, '..', '..', file), 'utf-8')
    body.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return
      if (/\b(lt|lte):[^,}]*\+\s*'[\\ÿ￿]/.test(line)) offenders.push(`${file}:${i + 1}`)
    })
  }
  t.alike(offenders, [], 'range bounds use prefixRange(), not an appended sentinel')
})
