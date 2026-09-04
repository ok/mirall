import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { projectProfile, profileSettled } from '../../src/renderer/profileGate.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

const PROFILE = { displayName: 'Alice', avatar: null }
const UNREAD = { data: undefined, error: null }

test('boot ends on the first answer, of either kind', (t) => {
  t.absent(profileSettled(UNREAD), 'nothing has landed yet')
  t.ok(profileSettled({ data: null, error: null }), 'null IS an answer — there is no profile')
  t.ok(profileSettled({ data: PROFILE, error: null }), 'so is a profile')
  t.ok(profileSettled({ data: undefined, error: new Error('worker down') }), 'and so is a failure')
})

test('the three shell states', (t) => {
  t.alike(projectProfile(UNREAD), { profile: null, needsSetup: false, loading: true },
    'before any answer: the boot screen, and NOT onboarding')
  t.alike(projectProfile({ data: null, error: null }), { profile: null, needsSetup: true, loading: false },
    'no profile: onboarding')
  t.alike(projectProfile({ data: PROFILE, error: null }), { profile: PROFILE, needsSetup: false, loading: false },
    'a profile: the app')
})

test('an unreadable profile opens onboarding rather than stranding the app on boot', (t) => {
  const gate = projectProfile({ data: undefined, error: new Error('worker unavailable') })
  t.absent(gate.loading, 'boot is over — a failure is an answer')
  t.ok(gate.needsSetup, 'and the safe answer is onboarding, not a blank app')
})

// REGRESSION (REVIEW-7: `error !== null` settles on an error of `undefined` — which is not an
// error at all. The store's own snapshot uses null, so nothing hit it today, but the function is
// pure, exported and typed `Error | null`: any caller handing it a partial snapshot settled boot
// instantly with no data, and "settled and no data" is how the gate spells "no profile". The user
// would meet onboarding over an identity that already exists.)
test('REGRESSION (REVIEW-7): an absent error is not an answer', (t) => {
  t.absent(profileSettled({ data: undefined, error: undefined }), 'nothing has landed')
  const gate = projectProfile({ data: undefined, error: undefined })
  t.ok(gate.loading, 'still booting')
  t.absent(gate.needsSetup, 'and NOT offering to set up a profile that may well exist')
})

test('the worker profile-needed signal ends boot on its own', (t) => {
  // It arrives before a read would, so waiting for one would hold the boot screen over a decision
  // the worker has already made.
  const gate = projectProfile({ ...UNREAD, profileNeeded: true })
  t.absent(gate.loading, 'no longer booting')
  t.ok(gate.needsSetup, 'onboarding')
})

// REGRESSION (ADOPT-A5: useProfile returned the query store's `loading`, which means "a read is in
// flight" and is raised again by EVERY refetch of an already-settled entry. app.tsx gates its whole
// tree on it, so each re-read unmounted the tree; that remounted all three useProfile call sites,
// each of which re-read profile:get, which raised the flag again. Self-sustaining: a real run
// issued ~13,900 rounds of every request in the app and never finished booting.)
//
// The projection is not given `loading` at all, so the trap is unrepresentable rather than merely
// avoided. This asserts that shape directly, because a future edit could re-add the parameter.
test('REGRESSION (ADOPT-A5): a read in flight over a settled profile does not re-enter boot', (t) => {
  const settledGate = projectProfile({ data: PROFILE, error: null })
  t.absent(settledGate.loading, 'settled')

  // Whatever else the store reports mid-refetch, the entry still holds its value — and that is the
  // only input the gate has.
  const refetching = projectProfile({ data: PROFILE, error: null, loading: true, profileNeeded: false })
  t.absent(refetching.loading, 'a refetch cannot put the shell back on the boot screen')
  t.alike(refetching, settledGate, 'the projection ignores anything but the answer itself')
})

test('REGRESSION (ADOPT-A5): the hook does not read the store loading flag', (t) => {
  const src = readFileSync(path.join(root, 'src', 'renderer', 'hooks', 'useProfile.ts'), 'utf8')
  const destructure = /const\s*\{([^}]*)\}\s*=\s*useQuery</.exec(src)
  t.ok(destructure, 'useProfile still reads the profile through the query store')
  t.absent(/\bloading\b/.test(destructure[1]),
    'and does not take `loading` off it — the shell gates its whole tree on that value')
})
