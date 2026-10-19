import test from 'brittle'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import { freshPeer } from '../helpers/store.js'
import { localTestnet } from '../helpers/testnet.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { waitFor } from '../helpers/bare-poll.js'
import { startManagedConsole } from '../helpers/managed-console.js'
import { signer, organization, sealBundle, encodeDriveEntry } from '../helpers/managed-seal.js'
import { ManagedConfig } from '../../src/worker/managed/managed-config.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getAuditConfig } from '../../src/shared/audit/audit-log.js'

const SIGNER = signer()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// While a drive peer is connected the drive is the source and the Console is not asked; once the
// drive has no peer, HTTPS takes over.
test('HTTPS is asked only while no drive peer is connected', async (t) => {
  const peer = await freshPeer(t)
  const bootstrap = await localTestnet(t)
  const api = await startManagedConsole(t)
  setRuntimeConfig({
    ...getRuntimeConfig(),
    dhtBootstrap: bootstrap,
    managedTestSigningKey: SIGNER.publicHex,
    managedAllowHttpLoopback: true,
    managedDriveGraceMs: 300,
    managedHttpsPollMs: 1000,
  })
  const store = new Corestore(tmpDir('managed-rule-publisher', t))
  const drive = store.namespace('drive').get({ name: 'db', exclusive: true })
  await drive.ready()
  const bee = new Hyperbee(drive, { keyEncoding: 'utf-8', valueEncoding: 'binary' })
  await bee.ready()
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (socket) => store.replicate(socket))
  swarm.join(drive.discoveryKey, { server: true, client: true })
  await swarm.flush()
  t.teardown(async () => { await swarm.destroy(); await bee.close(); await store.close() })

  const live = organization({ apiUrl: api.apiUrl, driveKey: drive.key })
  const now = Math.floor(Date.now() / 1000)
  const sealFor = (retention, issuedAt) => sealBundle({ signer: SIGNER, driveKey: drive.key, recipients: [live.bundlePublicKey], organization: { name: 'Acme Test GmbH' }, apiUrl: api.apiUrl, settings: { 'audit.retentionDays': retention }, issuedAt })
  await bee.sub('bundles').put('p1', encodeDriveEntry({ issuedAt: now, bundle: sealFor(90, now) }))
  api.set({ bundles: [{ profileId: 'p1', bytes: sealFor(90, now) }] })

  const managed = new ManagedConfig('managed-rule', { ipc: peer.fake.ipc, storage: peer.storage, network: true, installId: null, applyRelayConfig: () => ({ applied: 0 }) })
  await managed.ready()
  t.teardown(() => managed.close())
  await managed.accept(live.code)
  await waitFor(() => managed.drive?.peers > 0, 20000, { label: 'a drive peer' })
  const afterAccept = api.requests.length
  await sleep(1500)
  t.is(api.requests.length, afterAccept, 'no request while the drive has a peer')

  await bee.sub('bundles').put('p1', encodeDriveEntry({ issuedAt: now + 5, bundle: sealFor(365, now + 5) }))
  await waitFor(() => getAuditConfig().retentionDays === 365, 20000, { label: 'the drive update applied' })
  t.is(api.requests.length, afterAccept, 'the update came over the drive')

  await swarm.destroy()
  await waitFor(() => managed.drive.peers === 0, 20000, { label: 'the drive peer gone' })
  await waitFor(() => api.requests.length > afterAccept, 5000, { label: 'HTTPS taking over' })
  t.pass('HTTPS is asked once the drive has no peer')
})
