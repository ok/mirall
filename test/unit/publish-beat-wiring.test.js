import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8')

// The mirror of owner-pass-liveness-wiring.test.js, and it exists for the same reason: the beat is
// threaded through modules that only load under Bare, and the rule it pins is behavioural. The
// scheduler reports an item that is running and not advancing as wedged, and now reclaims its
// slot — so a phase that reports nothing is a phase that gets a healthy publish evicted mid-hash.

// REGRESSION (FIX-PUBLISH-HEARTBEAT: the publish item beat only from the per-chunk hash callback.
// Resolving the mount, settling the space's catalog batch and the deep verdict — each of which can
// take minutes on a large share — reported nothing, so a healthy publish read as wedged and, once
// recovery was wired, would have had its slot reclaimed mid-hash.)
test('REGRESSION (FIX-PUBLISH-HEARTBEAT): every phase of a publish beats, not just the hash', (t) => {
  const runner = read('src', 'shared', 'folders', 'publish-runner.js')
  const beats = [...runner.matchAll(/\bbeat\(\)/g)].length
  t.ok(beats >= 2, `the runner beats after resolve and after the catalog settle (found ${beats})`)
  t.ok(runner.includes('beat }'), 'and hands the beat on to the channel')

  const backend = read('src', 'shared', 'transfer', 'backends', 'overlay', 'overlay-backend.js')
  t.ok(/onProgress: \(len\) => \{ ticker\?\.push\(len\); beat\?\.\(\) \}/.test(backend), 'and so does every chunk of the publish')
})

// REGRESSION (FIX-DEEP-VERDICT-BEAT: the deep verdict's whole-file re-hash beat only AFTER it
// returned. compareDeep passed `undefined` for the per-chunk onProgress that hashOnDisk supports,
// so the longest phase of a deep pass was silent — and because hashOnDisk polls the item's abort
// signal per chunk, the recovery for the "wedged" item killed the hash that was making progress.
// A beat on either side of a phase says nothing about the phase; only one INSIDE it does.)
test('REGRESSION (FIX-DEEP-VERDICT-BEAT): the deep re-hash beats per chunk, not once it returns', (t) => {
  const backend = read('src', 'shared', 'transfer', 'backends', 'overlay', 'overlay-backend.js')
  t.ok(/overlayHashFile\(abs, beat, signal\)/.test(backend),
    'the beat IS the hash\'s per-chunk callback — passing undefined there is the defect')
  t.absent(/overlayHashFile\(abs, undefined, signal\)/.test(backend), 'and the discarded hook is gone')
  t.ok(/deepVerdict\(spaceId, share, relPath, absPath, catalog, signal, beat\)/.test(backend),
    'which means the beat has to reach deepVerdict in the first place')
})

test('the loose channel forwards the beat rather than dropping it', (t) => {
  const loose = read('src', 'shared', 'transfer', 'loose-overlay.js')
  t.ok(/async publish \(item, \{ absPath \}, \{ signal, beat \}\)/.test(loose),
    'the channel destructures it — a channel that rebuilt its opts would silently lose it')
  t.ok(/onProgress: \(len\) => \{ ticker\?\.push\(len\); beat\?\.\(\) \}/.test(loose), 'and beats per chunk')
})

test('the scheduler hands each item its own heartbeat', (t) => {
  const scheduler = read('src', 'shared', 'folders', 'publish-scheduler.js')
  t.ok(/const beat = slots\.started\(item\)/.test(scheduler),
    'the beat comes back from started(), so it is bound to that item\'s pass and cannot outlive it')
  t.ok(/execute\(item, \{ beat \}\)/.test(scheduler), 'and each executor gets its own')
})
