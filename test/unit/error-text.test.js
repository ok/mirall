import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { errorTextFor, FALLBACK_KEY } from '../../src/renderer/errorText.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const tr = (key) => 'T:' + key
const withCode = (message, code) => Object.assign(new Error(message), { code })

test('a mapped code renders its localized sentence', (t) => {
  t.is(errorTextFor(withCode('Invalid invite code', 'INVITE_INVALID'), tr), 'T:inviteInvalid')
  t.is(errorTextFor(withCode('Share not found', 'SHARE_NOT_FOUND'), tr), 'T:shareNotFound')
})

// REGRESSION (FIX-CODES-1: the fallback used to be err.message — English written for a log. That is
// how INVITE_INVALID, INVITE_EXPIRED and LEAVE_IN_PROGRESS reached every locale untranslated, and
// it is silent by construction: the wrong text still looks like text.)
test('REGRESSION (FIX-CODES-1): an internal code never leaks its English message', (t) => {
  const err = withCode('file path rejected — resolves outside the share folder: ../x', 'EPATH')
  const out = errorTextFor(err, tr)
  t.is(out, 'T:' + FALLBACK_KEY)
  t.absent(out.includes('share folder'), 'the diagnostic text is not shown to the user')
})

test('an uncoded failure falls back too', (t) => {
  t.is(errorTextFor(new Error('boom'), tr), 'T:' + FALLBACK_KEY)
  t.is(errorTextFor(null, tr), 'T:' + FALLBACK_KEY)
  t.is(errorTextFor('a string', tr), 'T:' + FALLBACK_KEY)
  t.is(errorTextFor(withCode('x', 42), tr), 'T:' + FALLBACK_KEY, 'a non-string code is no code')
})

// A file row is about a transfer, so "Transfer failed" is more specific there than the generic
// sentence, not less.
test('a surface can choose its own fallback', (t) => {
  t.is(errorTextFor(new Error('boom'), tr, 'transferFailed'), 'T:transferFailed')
  t.is(errorTextFor(withCode('x', 'TRANSFER_DISK_FULL'), tr, 'transferFailed'), 'T:transferDiskFull')
})

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(p)
  }
  return out
}

// The durable half. Every localized surface here was written correctly once before and drifted back
// one call site at a time, because falling back to the raw message is the shorter thing to type.
test('no renderer site falls back to a raw error message', (t) => {
  const offenders = []
  for (const f of walk(path.join(root, 'src', 'renderer'))) {
    if (/err instanceof Error \? err\.message/.test(readFileSync(f, 'utf8'))) {
      offenders.push(path.relative(root, f))
    }
  }
  t.alike(offenders, [], 'these files display a raw worker message instead of localized text')
})
