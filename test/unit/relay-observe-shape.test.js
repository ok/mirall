import test from 'brittle'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import BlindRelay from 'blind-relay'

const require = createRequire(import.meta.url)

test('hyperdht and Mirall resolve the same blind-relay', (t) => {
  const ours = require.resolve('blind-relay')
  const theirs = createRequire(require.resolve('hyperdht')).resolve('blind-relay')
  t.is(theirs, ours)
  t.is(require('blind-relay').Client, BlindRelay.Client, 'the CJS export and the ESM default share the class')
})

test('blind-relay exposes the two surfaces the observer couples to', (t) => {
  t.is(typeof BlindRelay.Client.from, 'function')
  t.is(BlindRelay.Client.prototype.pair.length, 3, 'pair(isInitiator, token, stream)')
  const src = readFileSync(require.resolve('blind-relay'), 'utf8')
  t.ok(src.includes("this.emit('pair', request.isInitiator, request.token, request.stream, remoteId)"), "'pair' carries (isInitiator, token, stream, remoteId)")
})

test('hyperdht obtains its relay client through Client.from on both sides', (t) => {
  const lib = (file) => readFileSync(require.resolve(`hyperdht/lib/${file}`), 'utf8')
  t.ok(lib('connect.js').includes('relay.Client.from(c.relaySocket'), 'dial side')
  t.ok(lib('server.js').includes('relay.Client.from(hs.relaySocket'), 'accept side')
})
