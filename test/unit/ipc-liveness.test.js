import test from 'brittle'
import { livenessVerdict, createLivenessWatch } from '../../src/shared/core/ipc-liveness.js'
import { FRAME } from '../../src/shared/contract/ipc-frames.js'

const timing = { keepaliveMs: 30000, graceMs: 10000 }

test('the verdict: quiet is asked, asked and still quiet is reaped', (t) => {
  const v = (lastSeenAt, probeSentAt, now) => livenessVerdict({ lastSeenAt, probeSentAt, now, ...timing })
  t.is(v(0, null, 29999), 'ok', 'recently heard from')
  t.is(v(0, null, 30000), 'probe', 'silent for the whole keepalive')
  t.is(v(0, 30000, 39999), 'ok', 'asked, still inside the grace')
  t.is(v(0, 30000, 40000), 'reap', 'asked, and the grace ran out')
})

function client(id, over = {}) {
  return { id, hello: { kind: 'test' }, lastSeenAt: 0, probeSentAt: null, lines: [], write(line) { this.lines.push(line) }, ...over }
}

test('the sweep asks quiet clients, reaps silent ones, and skips the host and the unintroduced', (t) => {
  const host = client(1)
  const quiet = client(2)
  const asked = client(3, { probeSentAt: 1000 })
  const anon = client(4, { hello: null })
  const reaped = []
  let now = 30000
  const sweep = createLivenessWatch({
    clients: { all: () => [host, quiet, asked, anon] },
    isExempt: (c) => c === host,
    detach: (c, reason) => reaped.push([c.id, reason]),
    now: () => now,
  })
  sweep(timing)
  t.alike(quiet.lines.map((l) => JSON.parse(l)), [{ type: FRAME.KEEPALIVE }])
  t.is(quiet.probeSentAt, 30000)
  t.alike(reaped, [[3, 'liveness']])
  t.alike(host.lines, [], 'the host is never asked')
  t.alike(anon.lines, [], 'nor a client that has not said hello')

  now = 35000
  sweep(timing)
  t.is(quiet.lines.length, 1, 'a client already asked is not asked again')
})
