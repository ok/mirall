import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isRevealable } = require('../../src/main/notifications.js')

// `shell:showInFolder` takes a renderer-supplied path and hands it to the OS shell, so
// this is an authorization boundary, not a convenience. It allows the user's home plus
// the configured download roots — the latter pushed from the worker, which owns the
// per-space overrides. Everything else must be refused.

const HOME = os.homedir()
const EXTERNAL_ROOT = path.join(path.sep + 'Volumes', 'Data', 'dl')

test('a path under the home directory is revealable with no roots configured', async (t) => {
  t.ok(await isRevealable(path.join(HOME, 'Downloads', 'f.txt'), []))
  t.ok(await isRevealable(path.join(HOME, 'Downloads', 'f.txt'), undefined), 'roots may be absent entirely')
})

test('a path outside home is refused when no root covers it', async (t) => {
  t.absent(await isRevealable(path.join(EXTERNAL_ROOT, 'f.txt'), []))
  t.absent(await isRevealable(path.join(path.sep + 'etc', 'passwd'), [EXTERNAL_ROOT]))
})

test('a path under a configured root outside home is revealable', async (t) => {
  t.ok(await isRevealable(path.join(EXTERNAL_ROOT, 'f.txt'), [EXTERNAL_ROOT]))
  t.ok(await isRevealable(path.join(EXTERNAL_ROOT, 'nested', 'f.txt'), [EXTERNAL_ROOT]), 'nested below the root')
  t.ok(await isRevealable(path.join(EXTERNAL_ROOT, 'f.txt'), ['/somewhere/else', EXTERNAL_ROOT]), 'any root in the list')
})

// The security-relevant pair: a prefix test without a prior resolve, or without a
// separator boundary, would let both of these through.
test('traversal out of a configured root is refused', async (t) => {
  t.absent(await isRevealable(path.join(EXTERNAL_ROOT, '..', '..', '..', 'etc', 'passwd'), [EXTERNAL_ROOT]))
  t.absent(await isRevealable(EXTERNAL_ROOT + path.sep + '..' + path.sep + 'other' + path.sep + 'f.txt', [EXTERNAL_ROOT]))
})

test('a sibling sharing a name prefix with a root is refused', async (t) => {
  t.absent(await isRevealable(path.join(EXTERNAL_ROOT + 'x', 'f.txt'), [EXTERNAL_ROOT]))
})

test('a root with a trailing separator still matches its children', async (t) => {
  t.ok(await isRevealable(path.join(EXTERNAL_ROOT, 'f.txt'), [EXTERNAL_ROOT + path.sep]))
})

test('malformed input is refused rather than throwing', async (t) => {
  t.absent(await isRevealable('', [EXTERNAL_ROOT]))
  t.absent(await isRevealable(null, [EXTERNAL_ROOT]))
  t.absent(await isRevealable(undefined, [EXTERNAL_ROOT]))
  t.absent(await isRevealable(path.join(EXTERNAL_ROOT, 'f.txt'), ['', null, undefined]), 'junk entries never match')
  t.absent(await isRevealable(path.join(EXTERNAL_ROOT, 'f.txt'), 'not-an-array'))
})

// REGRESSION (REVEAL-1): the home branch and the roots branch must answer the same
// question the same way. A local copy of the containment helper folded case on darwin
// while the home branch folded only on win32, so one authorization function gave two
// different answers for one path — and on a case-sensitive APFS volume the folding
// branch vouched for a genuinely different directory.
test('both branches apply one case-folding rule, and only Windows folds', async (t) => {
  const mixedRoot = path.join(EXTERNAL_ROOT.toUpperCase(), 'f.txt')
  const mixedHome = path.join(HOME.toUpperCase(), 'Downloads', 'f.txt')
  if (process.platform === 'win32') {
    t.ok(await isRevealable(mixedRoot, [EXTERNAL_ROOT]), 'win32 case-folds')
    t.ok(await isRevealable(mixedHome, []), 'and folds identically for home')
  } else {
    t.absent(await isRevealable(mixedRoot, [EXTERNAL_ROOT]), 'a differently-cased root is a different directory')
    t.absent(await isRevealable(mixedHome, []), 'and home answers the same way')
  }
})
