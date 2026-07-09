import createTestnet from 'hyperdht/testnet.js'

// A local 3-node DHT confined to localhost — keeps integration tests off the
// public DHT. Returns the bootstrap list to hand to each peer (threaded into
// the worker's runtime config as `dhtBootstrap`). Auto-torn-down via brittle.
export async function localTestnet (t) {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  return testnet.bootstrap
}
