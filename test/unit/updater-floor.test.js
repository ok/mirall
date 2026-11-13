// An automatic update never applies a version that is not newer than the running one. The rule is
// the updater dependency's: its _update() returns before staging when the running version compares
// >= the version in the update drive's /package.json. These tests drive the real class over a fake
// drive, so a dependency bump that drops the comparison turns them red.
import test from 'brittle'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const Updater = require('pear-runtime-updater')

const STAGING = 'STAGING_REACHED'

// The checkout answers /package.json and close(); anything else is what staging would touch
// (entry, list, mirror, ...) and throws, so a thrown STAGING_REACHED marks "staged".
function fakeCheckout(remoteVersion) {
  const state = { requested: false, closed: false }
  const known = {
    get: async (p) => {
      state.requested = true
      return p === '/package.json' && remoteVersion !== null
        ? Buffer.from(JSON.stringify({ version: remoteVersion }))
        : null
    },
    close: async () => { state.closed = true },
  }
  const co = new Proxy(known, {
    get(target, prop) {
      if (prop in target) return target[prop]
      throw new Error(STAGING)
    },
  })
  return { co, state }
}

async function runPass(running, remoteVersion) {
  const { co, state } = fakeCheckout(remoteVersion)
  const u = Object.create(Updater.prototype)
  Object.assign(u, {
    updates: true,
    closing: false,
    skipUpdate: null,
    version: running,
    bundled: false,
    prefetched: true,
    dir: '/nonexistent-update-floor',
    name: 'Mirall.app',
    checkout: null,
    drive: { update: async () => {}, core: { length: 7, fork: 0 }, checkout: () => co },
  })
  let staged = false
  try {
    await u._update()
  } catch (err) {
    if (err.message !== STAGING) throw err
    staged = true
  }
  return { staged, state, u }
}

const rows = [
  ['1.14.0', '1.13.1', false],
  ['1.14.0', '1.14.0', false],
  ['1.14.0', '1.14.0-beta.12', false],
  ['1.14.0-beta.123', '1.14.0-beta.57', false],
  ['1.14.0-beta.57', '1.14.0-beta.123', true],
  ['1.13.1', '1.14.0-beta.1', true],
  ['1.14.0-beta.123', '1.14.0', true],
  ['1.14.0', '1.14.1', true],
]

for (const [running, remote, staged] of rows) {
  const name = staged
    ? `running ${running} stages remote ${remote}, which is newer`
    : `running ${running} never stages remote ${remote}, which is not newer`
  test(name, async (t) => {
    const r = await runPass(running, remote)
    t.ok(r.state.requested, 'the manifest was read, so the comparison ran')
    t.is(r.staged, staged)
    if (!staged) {
      t.ok(r.state.closed, 'the checkout was closed')
      t.ok(r.u.checkout === null, 'no checkout is left held')
    }
  })
}

test('a drive without /package.json is never staged', async (t) => {
  const r = await runPass('1.14.0', null)
  t.ok(r.state.requested, 'the manifest was requested')
  t.ok(r.state.closed, 'the checkout was closed')
  t.is(r.staged, false)
  t.ok(r.u.checkout === null, 'no checkout is left held')
})

test('the app hands the updater its own package.json version', (t) => {
  const src = fs.readFileSync(new URL('../../src/main/updater.js', import.meta.url), 'utf8')
  t.ok(/const version = pkg\.version\b/.test(src), 'version is assigned from package.json')
  const start = src.indexOf('new PearRuntime({')
  t.ok(start >= 0, 'the updater construction is found')
  const end = src.indexOf('\n  })', start)
  t.ok(end > start, 'the end of the options object is found')
  t.ok(/^\s+version,$/m.test(src.slice(start, end)), 'the options carry version')
})
