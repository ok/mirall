import Protomux from 'protomux'
import { Duplex } from 'streamx'
import { tmpStore, tmpDir } from './overlay-engine-helpers.js'
import { HyperOverlayV2 } from '../../src/shared/transfer/backends/overlay/engine/overlay-v2.js'

// In-memory overlay peers for the vendor protocol tests: a paired duplex stands in for a socket.

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
  const o = new HyperOverlayV2(tmpStore(label), { namespace: 'mirall-overlay', destDir: tmpDir(label + '-d'), partialSuffix: SUFFIX, ...opts })
  await o.ready()
  t.teardown(async () => { try { await o.close() } catch {} })
  return o
}

// Returns [a's record of b, b's record of a]: sending on b's record delivers to a.
export function link(a, b) {
  const [x, y] = makeDuplex()
  return [a.attachProtocol(Protomux.from(x)), b.attachProtocol(Protomux.from(y))]
}
