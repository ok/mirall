import test from 'brittle'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { toastKey } from '../../src/renderer/components/toast/toastKey.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TOAST = path.resolve(here, '../../src/renderer/components/toast')
const read = (name) => readFileSync(path.join(TOAST, name), 'utf8')

// REGRESSION (FIX-TOAST-1: show() deduped on the id alone, and a caller that passed none got a
// fresh `t-<timestamp>-<random>` every call. Three retries of a failing action — RemoveFileModal
// and LeaveSpaceModal both toast errorText(err) with no id — stacked three identical banners up to
// MAX_VISIBLE.)
test('REGRESSION (FIX-TOAST-1): the same sentence said twice derives the same id', (t) => {
  const first = toastKey('error', 'Something went wrong. Try again.')
  const second = toastKey('error', 'Something went wrong. Try again.')
  t.is(first, second, 'a retry replaces the banner it repeats')
})

test('a different sentence, or the same one in another variant, stays its own toast', (t) => {
  t.not(toastKey('error', 'Disk full'), toastKey('error', 'Not found'))
  t.not(toastKey('error', 'Done'), toastKey('success', 'Done'))
})

// The derivation is only reached when the caller names no id: the two toast bridges reword one
// persistent fault under a fixed id, and that replacement must keep working.
test('an explicit id still wins', (t) => {
  const src = read('ToastProvider.tsx')
  t.ok(/opts\.id \?\? toastKey\(variant, message\)/.test(src))
})

// REGRESSION (FIX-TOAST-2: keying the list by id alone reused the component instance across a
// replacement. Its timing refs are initialised once per mount, so the countdown carried the old
// elapsed time while the provider re-armed the full duration — and an unchanged role="alert" node
// is not re-announced, leaving a screen-reader user no signal that the retry failed too.)
test('REGRESSION (FIX-TOAST-2): a replacement remounts its toast', (t) => {
  t.ok(/key=\{`\$\{item\.id\}:\$\{item\.seq\}`\}/.test(read('ToastContainer.tsx')))
  t.ok(/seq: \+\+seqRef\.current/.test(read('ToastProvider.tsx')), 'and every show bumps the seq')
})
