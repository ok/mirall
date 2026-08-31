import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const entrypoint = path.join(here, '..', '..', 'src', 'worker', 'main.js')

// Handlers that take the router's context — the request id and the cancellation signal. The seam
// reaches all 86 requests; what makes it real is how many read it. This is a FLOOR, not a ceiling:
// the router grew the context for handlers to use, and a change that quietly drops a consumer would
// otherwise leave the finding open while looking closed.
const FLOOR = 3

function contextAwareHandlers () {
  const src = readFileSync(entrypoint, 'utf8')
  const names = []
  // `ipc.handle('x', async (msg, ctx) => ...)` — a second parameter is the context by construction;
  // the router passes exactly two arguments.
  for (const m of src.matchAll(/ipc\.handle\(\s*'([^']+)'\s*,\s*(?:async\s*)?\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*/g)) {
    names.push(m[1])
  }
  // Handlers that delegate to a named function taking (msg, ctx).
  for (const m of src.matchAll(/^async function (\w+)\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*ctx/gm)) {
    names.push(m[1])
  }
  return names
}

test('the handler context has more than a token consumer set, and only grows', (t) => {
  const names = contextAwareHandlers()
  t.ok(names.length >= FLOOR,
    `${names.length} handler(s) read the request context (${names.join(', ')}), floor ${FLOOR} — ` +
    'the id and signal reach every handler; a change that stops one reading them lowers this')
})

test('share:list-files hands its signal to the listing', (t) => {
  // The first handler wired to it, and the one the renderer's query store actually cancels: a folder
  // listing the user has navigated away from. Named explicitly because the ratchet above counts
  // consumers without caring which. The listing itself lives in share-listing.js, where its
  // behaviour is asserted directly (test/integration/share-listing-cancel.test.js) — this only pins
  // that the entrypoint still passes the token through.
  const src = readFileSync(entrypoint, 'utf8')
  t.ok(/ipc\.handle\('share:list-files',\s*async\s*\(msg,\s*ctx\)/.test(src), 'it takes the context')
  t.ok(src.includes("{ signal: ctx?.signal ?? null }"), 'and passes the signal down')
})
