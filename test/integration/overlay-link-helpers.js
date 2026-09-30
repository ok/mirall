import Protomux from 'protomux'
import { Duplex } from 'streamx'
import { tmpStore } from './overlay-engine-helpers.js'
import { makeOverlay } from '../helpers/overlay-engine.js'

// In-memory overlay peers for the engine protocol tests: a paired duplex stands in for a socket.

export const SUFFIX = '.mirall.part'

export function makeDuplex() {
  let aWrite, bWrite
  const a = new Duplex({ write(d, cb) { bWrite(d); cb() }, read() {} })
  const b = new Duplex({ write(d, cb) { aWrite(d); cb() }, read() {} })
  aWrite = (d) => a.push(d)
  bWrite = (d) => b.push(d)
  return [a, b]
}

export async function overlay(t, label, opts = {}) {
  const o = makeOverlay(tmpStore(label), { namespace: 'mirall-overlay', partialSuffix: SUFFIX, ...opts })
  await o.ready()
  t.teardown(async () => { try { await o.close() } catch {} })
  return o
}

// Returns [a's record of b, b's record of a]: sending on b's record delivers to a.
export function link(a, b) {
  const [x, y] = makeDuplex()
  return [a.attachProtocol(Protomux.from(x)), b.attachProtocol(Protomux.from(y))]
}
