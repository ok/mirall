import createTestnet from 'hyperdht/testnet.js'

export async function startTestnet() {
  const net = await createTestnet(3)
  return { bootstrap: net.bootstrap, destroy: () => net.destroy() }
}
