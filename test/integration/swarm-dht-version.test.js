import test from 'brittle'
import fs from 'bare-fs'
import { getSwarmStatus } from '../../src/shared/transfer/swarm.js'

// REGRESSION (FIX-DHT-VERSION): the version lookup resolved '../../node_modules/hyperdht' from
// src/shared/transfer/, i.e. src/node_modules — which does not exist. Every read threw ENOENT and
// the status reported 'unknown', so the Network Status panel's DHT version field was permanently
// blank-ish. Nothing pinned the value, in either direction.
//
// Integration, not unit: swarm.js pulls bare-* and will not load under node.
test('REGRESSION (FIX-DHT-VERSION): the reported DHT version is the real one', async (t) => {
  const status = getSwarmStatus()
  const real = JSON.parse(fs.readFileSync(new URL('../../node_modules/hyperdht/package.json', import.meta.url), 'utf8')).version
  t.ok(real && real !== 'unknown', 'the package is readable from the test, so the app can read it too')
  t.is(status.versions.dht, real, 'and the status reports it rather than the ENOENT fallback')
})
