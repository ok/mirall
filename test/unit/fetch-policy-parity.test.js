import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(path.resolve(here, '../../src', p), 'utf8')

const ENGINE = 'shared/transfer/backends/overlay/overlay-download.js'
const MIRROR = 'shared/folders/foreign-folders.js'
const CHANNEL = 'shared/transfer/backends/overlay/overlay-channel.js'

// Two producers move bytes through one overlay: the download engine and the foreign-folder mirror.
// A failure rule that holds for one has to hold for the other, and nothing else can notice when
// they drift — to the compiler they are unrelated objects, which is the same trap overlay-channel.js
// was built to close for the two channels one level down.
//
// Source-scanned rather than imported: both modules pull in bare-*, so a Node runner cannot load
// them. Same technique and same rationale as preview-shape-parity.test.js.

test('both producers gate a fetch on reachability', (t) => {
  t.ok(/ownerOnline\(job\.ownerPublicKey\)/.test(read(ENGINE)), 'the engine gates on the owner')
  // Anchored on the call, not the declaration: /mayFetch\(mount\)/ alone matches
  // `function mayFetch(mount) {`, so both call sites could be deleted and this still passed.
  t.ok(/const canFetch = mayFetch\(mount\)/.test(read(MIRROR)), 'the mirror gates its walk')
  t.ok(/if \(!mayFetch\(mount\)\)/.test(read(MIRROR)), 'and its tick')
})

// Deliberately one-sided. The two look like the same question and are not: the mirror asks whether a
// chunk scheduler ever ran (onEnd fired), the engine asks whether the vendor attached a cause code.
// An earlier draft of this file demanded both use classifyMiss, and forcing the engine onto it
// inverted its retry branch — the engine suite caught it. The shared rule owns the mirror's fact
// only; the engine's stays its own.
test('the mirror classifies a miss through the shared rule', (t) => {
  t.ok(/classifyMiss\(/.test(read(MIRROR)), 'the mirror uses the shared classifier')
  t.absent(/function classifyMirrorMiss/.test(read(MIRROR)), 'and keeps no private copy')
})

test('one terminal-fault set, read by every producer that judges a fault', (t) => {
  for (const f of [ENGINE, MIRROR, CHANNEL]) {
    t.ok(/isTerminalFault\(/.test(read(f)), `${f} consults the shared set`)
  }
  t.absent(/SUPPRESSED_CODES\s*=/.test(read(ENGINE)), 'the engine keeps no private set')
  t.absent(/USER_FACING_ERRORS\s*=/.test(read(CHANNEL)), 'the channel keeps no private set')
})

test('both producers reach the vendor through the shared instrumentation', (t) => {
  for (const f of [ENGINE, MIRROR]) {
    t.absent(/makeFetchDiag\(/.test(read(f)), `${f} does not build its own diag`)
    t.absent(/makeProgressTicker\(/.test(read(f)), `${f} does not build its own ticker`)
  }
})

test('both producers refuse a fetch whose destination is gone', (t) => {
  t.ok(/dirExists\(path\.dirname\(job\.finalPath\)\)/.test(read(ENGINE)), 'the engine preflights')
  // Not /mountRootAvailable\(/: that matches two pre-existing calls in the auto-pause probes, so
  // the preflight could be deleted without failing. The preflight lives in mountCanTake.
  t.ok(/probe\.rootAvailable\(\)/.test(read(MIRROR)), 'the mirror preflights its mount root')
})

test('both producers preflight free space through one rule', (t) => {
  for (const f of [ENGINE, MIRROR]) {
    t.ok(/shortfall\(\{/.test(read(f)), `${f} asks the shared capacity rule`)
    t.ok(/allocatedBytes/.test(read(f)), `${f} credits what a resumed partial already took`)
  }
  t.absent(/FREE_SPACE_HEADROOM\s*=/.test(read(ENGINE)), 'the headroom is declared once, not here')
})

// One edge, one dispatcher. The offline fix left two hooks fired back to back for the same event
// because there was no shared one to join; that is the shape this forbids.
test('the peer-online edge has one dispatcher, not one hook per producer', (t) => {
  const src = read('shared/transfer/swarm.js')
  t.absent(/peerOnlineHook\?\.\(/.test(src), 'no per-producer hook call')
  t.ok(/for \(const fn of peerOnlineHooks\)/.test(src), 'a single subscriber loop')
})

// The layering rule from testing.md: a policy module must stay Node-loadable, or the unit tests
// above it silently belong to a different runner.
for (const f of [
  'shared/transfer/backends/overlay/fetch-policy.js',
  'shared/transfer/free-space.js',
  'shared/folders/mirror-reach.js',
]) {
  test(`${f} imports no bare-* module`, (t) => {
    t.absent(/from '(bare-[a-z]+)'/.test(read(f)), 'stays unit-testable under Node')
  })
}
