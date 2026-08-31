import test from 'brittle'
import { foldListing, emptyFold, resolveListing } from '../../src/renderer/shareFilesFold.js'

const toEntry = (e) => ({ relPath: e.relPath, size: 1, hash: 'h', mtime: 1, status: 'remote' })
const res = (paths) => ({ entries: paths.map((relPath) => ({ relPath })), complete: true })
const err = (message, code) => Object.assign(new Error(message), code ? { code } : {})

const seeded = () => foldListing(emptyFold, res(['a', 'b']), toEntry)

test('no error passes the rows through untouched', (t) => {
  const fold = seeded()
  const out = resolveListing(fold, null)
  t.is(out.rows, fold.rows, 'same reference')
  t.is(out.error, null)
  t.is(out.info, fold.info)
})

// A deleted or access-revoked share must clear the list, or the user keeps browsing a folder that
// no longer exists.
test('a terminal code clears the rows and surfaces the message', (t) => {
  for (const code of ['NOT_FOUND', 'EOWNERSHIP']) {
    const out = resolveListing(seeded(), err('gone', code))
    t.alike(out.rows, [], `${code} clears the listing`)
    t.is(out.info, null, 'and its header')
    t.is(out.error, 'gone', 'and says why')
    t.ok(out.terminal)
  }
})

// REGRESSION (FIX-NEVER-BLANK-STORE: a timeout is a transient read failure, not a statement about
// the folder's contents. Clearing on it would empty a folder during an ordinary network hiccup.)
test('REGRESSION (FIX-NEVER-BLANK-STORE): a transient failure keeps the rows and stays silent', (t) => {
  const fold = seeded()
  const out = resolveListing(fold, err('IPC timeout: share:list-files'))
  t.is(out.rows, fold.rows, 'the rows on screen survive')
  t.is(out.error, null, 'and no error is shown over a list that is still good')
  t.absent(out.terminal)
})

test('a transient failure with nothing on screen does surface', (t) => {
  const out = resolveListing(emptyFold, err('IPC timeout: share:list-files'))
  t.alike(out.rows, [])
  t.is(out.error, 'IPC timeout: share:list-files', 'a blank view must explain itself')
})

test('an unknown code is treated as transient', (t) => {
  const fold = seeded()
  const out = resolveListing(fold, err('peer unavailable', 'PEER_GONE'))
  t.is(out.rows, fold.rows, 'only the two known terminal codes clear the list')
  t.absent(out.terminal)
})
