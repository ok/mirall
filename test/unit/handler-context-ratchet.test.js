import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const workerDir = path.join(here, '..', '..', 'src', 'worker')

// The entry plus the handler modules it registers: a handler is a router-context consumer wherever
// it is registered from, so the scan follows the registrations rather than one file.
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : [])
  })
}
function workerSource() {
  const files = [path.join(workerDir, 'main.js'), ...walk(path.join(workerDir, 'ipc'))]
  return files.map((f) => readFileSync(f, 'utf8')).join('\n')
}

// Handlers that read the ROUTER's context — the request id and the cancellation signal ipc.js hands
// every handler as its second argument. A floor, not a ceiling: the seam reaches all 86 requests and
// what makes it real is how many use it, so a change that quietly drops the last consumer would
// otherwise leave the finding closed on paper.
//
// Only `ipc.handle` registrations count. `handleMembershipControl`, `onGrant` and `onCancel` also
// take a parameter named `ctx` and are NOT router handlers — they are peer-frame handlers reached
// through the composition root's `membershipControl`, and their ctx is `{ peerInfo, reply }` from the
// swarm. Counting by parameter name instead of by registration made this ratchet read 3 when the
// true number of router-context consumers was 0.
const FLOOR = 1

function routerContextHandlers() {
  const src = workerSource()
  return [...src.matchAll(/ipc\.handle\(\s*'([^']+)'\s*,\s*(?:async\s*)?\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*/g)]
    .map((m) => m[1])
}

test('the router context has a consumer, and the count only grows', (t) => {
  const names = routerContextHandlers()
  t.ok(names.length >= FLOOR,
    `${names.length} handler(s) read the router context (${names.join(', ') || 'none'}), floor ${FLOOR}`)
})

test('a parameter named ctx on a peer-frame handler is not a router-context consumer', (t) => {
  // Pins the distinction this ratchet got wrong once: the two channels both call their second
  // argument `ctx` and carry entirely different shapes.
  const src = workerSource()
  t.ok(/async function handleMembershipControl\(msg, ctx\)/.test(src), 'the peer-frame handler still exists')
  t.ok(src.includes('membershipControl: handleMembershipControl'), 'and reaches the swarm through the root, not ipc.handle')
  t.absent(routerContextHandlers().includes('handleMembershipControl'), 'so it must not be counted here')
})

test('share:list-files hands its signal to the listing', (t) => {
  // The first router-context consumer, and the one the renderer's query store actually cancels: a
  // folder listing whose view has been superseded. The listing's own behaviour is asserted in
  // test/integration/share-listing-cancel.test.js; this only pins that the entrypoint passes through.
  const src = workerSource()
  t.ok(/ipc\.handle\('share:list-files',\s*async\s*\(msg,\s*ctx\)/.test(src), 'it takes the context')
  t.ok(src.includes("{ signal: ctx?.signal ?? null }"), 'and passes the signal down')
})
