import test from 'brittle'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pushToast, isSticky, MAX_VISIBLE } from '../../src/renderer/components/toast/toastStack.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TOAST = path.resolve(here, '../../src/renderer/components/toast')
const read = (name) => readFileSync(path.join(TOAST, name), 'utf8')

let seq = 0
const sticky = (id) => ({ id, seq: ++seq, variant: 'info', message: id, duration: 0 })
const timed = (id, duration = 5000) => ({ id, seq: ++seq, variant: 'info', message: id, duration })
const showAll = (items, ...toasts) => toasts.reduce((stack, t) => pushToast(stack, t), items)
const ids = (items) => items.map((t) => t.id)

// REGRESSION (FIX-373: the stack trimmed to four by position, oldest first, and never looked at
// duration. A sticky toast is on screen longest, so it was the first to go: four transfer toasts in
// a row removed a pending join request with its Review action, and nothing re-raised it.)
test('REGRESSION (FIX-373): a sticky toast survives four newer auto-dismissing toasts', (t) => {
  const stack = showAll([], sticky('join-req:space:bob'), timed('a'), timed('b'), timed('c'), timed('d'))
  t.ok(ids(stack).includes('join-req:space:bob'), 'the pending join request is still on screen')
  t.alike(ids(stack), ['join-req:space:bob', 'b', 'c', 'd'], 'the oldest auto-dismissing toast made room')
})

// REGRESSION (FIX-373: four stickies up, one timed toast arrives, and the oldest sticky was dropped
// to keep the stack at four.)
test('REGRESSION (FIX-373): four sticky toasts plus one timed toast keeps all four sticky ones', (t) => {
  const stack = showAll([], sticky('s1'), sticky('s2'), sticky('s3'), sticky('s4'), timed('t'))
  t.alike(ids(stack), ['s1', 's2', 's3', 's4', 't'], 'every sticky stays and the new toast is shown')
})

test('with no sticky toast the stack is capped as before, oldest out', (t) => {
  const stack = showAll([], timed('a'), timed('b'), timed('c'), timed('d'), timed('e'))
  t.is(stack.length, MAX_VISIBLE)
  t.alike(ids(stack), ['b', 'c', 'd', 'e'])
})

test('only auto-dismissing toasts are evicted, oldest first', (t) => {
  const stack = showAll([], sticky('s1'), timed('old'), sticky('s2'), sticky('s3'), timed('new'))
  t.alike(ids(stack), ['s1', 's2', 's3', 'new'], 'the older timed toast left; no sticky did')
})

test('a new sticky toast over a full timed stack evicts the oldest timed toast', (t) => {
  const stack = showAll([], timed('a'), timed('b'), timed('c'), timed('d'), sticky('offline'))
  t.alike(ids(stack), ['b', 'c', 'd', 'offline'])
})

test('the toast just shown is never the one evicted; stickies alone let the stack grow', (t) => {
  const stickies = showAll([], sticky('s1'), sticky('s2'), sticky('s3'), sticky('s4'), sticky('s5'))
  t.is(stickies.length, 5, 'five stickies, none evicted')
  const withNotice = pushToast(stickies, timed('notice'))
  t.is(withNotice.length, 6)
  t.is(withNotice.at(-1).id, 'notice', 'the newest notice is shown, not dropped unseen')
})

test('a replacement under the same id moves it to the top and evicts nothing', (t) => {
  const stack = showAll([], timed('a'), timed('b'), timed('c'), timed('d'), timed('b'))
  t.alike(ids(stack), ['a', 'c', 'd', 'b'])
})

test('a replacement over the cap evicts nothing, since the stack does not grow', (t) => {
  const over = showAll([], sticky('s1'), sticky('s2'), sticky('s3'), sticky('s4'), timed('error'))
  const stack = pushToast(over, sticky('s2'))
  t.alike(ids(stack), ['s1', 's3', 's4', 'error', 's2'], 'the timed toast stays')
})

test('a toast the user is hovering or focused on is not evicted', (t) => {
  const stack = pushToast(showAll([], timed('a'), timed('b'), timed('c'), timed('d')), timed('e'), new Set(['a']))
  t.alike(ids(stack), ['a', 'c', 'd', 'e'], 'the next oldest made room instead')
})

test('a sticky replaced by a timed toast under its id is auto-dismissing from then on', (t) => {
  let stack = showAll([], sticky('connectivity'), timed('a'), timed('b'), timed('c'))
  stack = pushToast(stack, timed('connectivity', 4000))
  t.alike(ids(stack), ['a', 'b', 'c', 'connectivity'], 'replaced in place, nothing evicted')
  stack = showAll(stack, timed('d'), timed('e'))
  t.alike(ids(stack), ['c', 'connectivity', 'd', 'e'], 'and it ages out like any timed toast')
})

test('a negative duration is sticky, as it is for the countdown and the hover pause', (t) => {
  const stack = showAll([], timed('x', -1), timed('a'), timed('b'), timed('c'), timed('d'))
  t.ok(ids(stack).includes('x'))
})

test('isSticky is the one rule: no positive duration means no countdown', (t) => {
  t.ok(isSticky(0))
  t.ok(isSticky(-1))
  t.ok(isSticky(Number.NaN))
  t.absent(isSticky(4000))
})

test('the provider and the toast read stickiness from the stack module', (t) => {
  t.ok(/isSticky\(duration\)/.test(read('ToastProvider.tsx')), 'the provider arms no timer for a sticky toast')
  t.absent(/\.duration <= 0/.test(read('Toast.tsx')), 'the toast has no second spelling of the rule')
})

test('pushToast does not mutate the stack it is given', (t) => {
  const before = showAll([], timed('a'), timed('b'), timed('c'), timed('d'))
  const snapshot = ids(before)
  pushToast(before, timed('e'))
  t.alike(ids(before), snapshot)
})

test('the provider shows through pushToast and holds no cap of its own', (t) => {
  const src = read('ToastProvider.tsx')
  t.ok(/setItems\(\(prev\) => pushToast\(prev, item, pausedRef\.current\)\)/.test(src))
  t.absent(/MAX_VISIBLE/.test(src))
})
