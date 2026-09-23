import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const renderer = path.join(root, 'src', 'renderer')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const SESSION = 'src/renderer/platform/relay-session.ts'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'locales') walk(p, out) }
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(root, p).split(path.sep).join('/')

// REGRESSION (FIX-RELAYSESSION-1: each relay session flag was cleared by whichever act happened to
// know about it — the reconnect cleared one, the window reload used to clear the other, and after
// the reload went nothing cleared it at all. A worker restart then left the apply flag armed over a
// change the new process had already booted with, so Settings and Network Status both showed a
// warning offering an Apply that could not clear it.)
test('REGRESSION (FIX-RELAYSESSION-1: a new worker generation clears every relay session flag)', (t) => {
  const src = read(SESSION)
  const setters = [...src.matchAll(/export function (set\w+)\(/g)].map((m) => m[1])
  t.ok(setters.length >= 2, 'the session declares the flags a restart invalidates')
  const at = src.indexOf('onResync(')
  t.ok(at > 0, 'and it is the resync that clears them, not a call site that can drift')
  const hook = src.slice(at)
  t.ok(/reason !== 'new-worker'/.test(hook),
    'and only a new PROCESS clears them — a re-read for any other reason is the worker they booted with')
  for (const setter of setters) {
    t.ok(hook.includes(`${setter}(false)`), `${setter} is cleared by the new generation`)
  }
})

// The other half of the same defect: a useState copy taken at mount keeps showing the notice after
// the store has cleared it, because nothing re-reads the module. The store rule, once — useQuery
// states it for worker data and this states it for the session.
test('the relay session is read through its subscription, never mirrored into component state', (t) => {
  const readers = walk(renderer)
    .filter((f) => rel(f) !== SESSION && readFileSync(f, 'utf8').includes('platform/relay-session.js'))
  t.ok(readers.length > 0, 'the session has readers')
  const mirrored = readers
    .filter((f) => /useState\(\s*(isApplyArmed|isReconnectPending)\b/.test(readFileSync(f, 'utf8')))
    .map(rel)
  t.alike(mirrored, [], 'a component copy can disagree with the store it was taken from')
  const unsubscribed = readers
    .filter((f) => {
      const text = readFileSync(f, 'utf8')
      return /\b(isApplyArmed|isReconnectPending)\(/.test(text) && !text.includes('subscribeRelaySession')
    })
    .map(rel)
  t.alike(unsubscribed, [], 'a reader that renders a flag follows it through subscribeRelaySession')
})
