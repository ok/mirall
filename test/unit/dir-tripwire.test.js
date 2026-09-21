import test from 'brittle'
import { classifyResolved, pathArity } from '../../src/shared/core/dir-tripwire.js'
import mainTripwire from '../../src/main/dir-tripwire.js'

// The rule exists twice — ESM for the Bare worker, CJS for Electron main, which cannot import the
// ESM one synchronously at boot. Every case below runs against BOTH, so a fix applied to one copy
// and not the other fails here rather than in production.
const impls = [
  ['shared (worker)', classifyResolved],
  ['main (cjs)', mainTripwire.classifyResolved],
]

const DIR = '/Users/o/Library/Application Support/Mirall'

const cases = [
  // The three things worth stopping.
  [DIR, 'data-dir', 'the profile directory itself'],
  [DIR + '/', 'data-dir', 'a trailing separator is still the profile directory'],
  ['/Users/o/Library/Application Support', 'ancestor', 'the directory that contains it'],
  ['/Users/o/Library', 'ancestor', 'a grandparent'],
  ['/', 'ancestor', 'the root'],
  [DIR + '/app-storage', 'store', 'the whole corestore in one act'],

  // Ordinary work, which must never trip: everything below the store is deleted routinely.
  [DIR + '/app-storage/db', null, 'a directory inside the store'],
  [DIR + '/app-storage/db/000031.log', null, 'a write-ahead log segment'],
  [DIR + '/pear-runtime/next', null, 'the updater staging directory'],
  [DIR + '/relay-ticket.enc', null, 'the relay member seed'],
  [DIR + '/config.json', null, 'the config file'],

  // Siblings that merely share a prefix. Getting this wrong would refuse the user's own backups.
  ['/Users/o/Library/Application Support/Mirall copy', null, 'a sibling with a space'],
  ['/Users/o/Library/Application Support/Mirall-wiped-20260918', null, 'a sibling with a suffix'],
  ['/Users/o/Library/MirallSnapshots', null, 'the snapshot directory'],

  // Nothing to classify.
  ['', null, 'an empty target'],
  [null, null, 'a non-string target'],
  [undefined, null, 'an undefined target'],
]

for (const [label, fn] of impls) {
  test(`classifyResolved — ${label}`, (t) => {
    for (const [target, expected, why] of cases) {
      t.is(fn(target, DIR, '/'), expected, `${why}: ${JSON.stringify(target)}`)
    }
  })
}

test('an empty dataDir classifies nothing — the guard is inert until armed', (t) => {
  for (const [, fn] of impls) {
    t.is(fn(DIR, '', '/'), null)
    t.is(fn(DIR, null, '/'), null)
  }
})

// rename/renameSync are the calls that can REPLACE a directory entry, so both of their path
// arguments have to be classified — a swap is only visible from the side being overwritten.
test('rename guards both paths, everything else guards one', (t) => {
  t.is(pathArity('rename'), 2)
  t.is(pathArity('renameSync'), 2)
  t.is(pathArity('rm'), 1)
  t.is(pathArity('rmSync'), 1)
  t.is(pathArity('rmdir'), 1)
  t.is(pathArity('unlink'), 1)
})
