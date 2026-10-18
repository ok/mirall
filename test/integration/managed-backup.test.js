import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { tmpDir, tmpPath } from '../helpers/bare-tmp.js'
import { waitFor } from '../helpers/bare-poll.js'
import { startManagedConsole } from '../helpers/managed-console.js'
import { signer, organization, sealBundle } from '../helpers/managed-seal.js'
import { registerManaged } from '../../src/worker/ipc/managed.js'
import { registerBackup } from '../../src/worker/ipc/backup.js'
import { createPassphraseThrottle } from '../../src/shared/core/identity-recovery.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { backupFolderKey } from '../../src/shared/contract/managed-settings.js'
import { devicePlatform } from '../../src/worker/managed/device-facts.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'

const SIGNER = signer()
const PASS = 'a long enough passphrase'

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

async function setup(t, { share, required = true }) {
  const peer = await freshPeer(t)
  registerManaged(peer.fake.ipc, { service: peer.root.managed })
  registerBackup(peer.fake.ipc, { backup: peer.root.backup, paused: peer.root.backupPaused, openRecovery: createPassphraseThrottle() })
  setRuntimeConfig({ ...getRuntimeConfig(), managedTestSigningKey: SIGNER.publicHex, managedAllowHttpLoopback: true, managedPreviewTimeoutMs: 1500, managedHttpsPollMs: 60_000 })
  await createSpace('Projects')
  const api = await startManagedConsole(t)
  const org = organization({ apiUrl: api.apiUrl })
  const settings = { [backupFolderKey(devicePlatform())]: `${share}/{user}/{host}-{install}`, ...(required ? { 'backup.required': true } : {}) }
  api.set({ bundles: [{ profileId: 'p1', bytes: sealBundle({ signer: SIGNER, driveKey: org.driveKey, recipients: [org.bundlePublicKey], organization: { name: 'Acme Test GmbH' }, apiUrl: api.apiUrl, settings }) }] })
  const view = await peer.fake.call('managed:accept', { code: org.code })
  const ownSettings = () => JSON.parse(fs.readFileSync(path.join(path.dirname(peer.storage), 'settings.json'), 'utf8')).backup
  return { ...peer, view, ownSettings }
}

test('the organization\'s folder is set up with the person\'s passphrase, below an existing share only', async (t) => {
  const share = tmpDir('managed-share', t)
  const p = await setup(t, { share })
  const folder = p.view.backupFolder
  t.ok(folder.startsWith(share + path.sep), 'resolved below the share')
  t.absent(fs.existsSync(folder), 'nothing is created before setup')

  const before = await p.fake.call('backup:status', {})
  t.is(before.folder, null, 'an organization\'s folder is not set up until the person chooses a passphrase')
  t.is(before.verdict, 'stopped')
  t.is(before.verdictReason, 'required-not-set-up')
  t.is(before.prompt, 'offer')
  t.is(await codeOf(p.fake.call('backup:prompt', { prompt: 'offer', action: 'snooze' })), 'MANAGED_LOCKED', 'a required backup cannot be snoozed')

  t.is(await codeOf(p.fake.call('backup:setup', { folder: tmpDir('managed-elsewhere', t), passphrase: PASS })), 'MANAGED_LOCKED', 'another folder is refused')
  const after = await p.fake.call('backup:setup', { folder, passphrase: PASS })
  t.is(after.folder, folder)
  t.ok(fs.existsSync(folder), 'this device\'s folders are created below the share')
  await waitFor(async () => (await p.fake.call('backup:status', {})).lastSuccessAt !== null, 20000, { label: 'the first backup' })
  t.alike(p.ownSettings(), { folder: null, repoId: null }, 'the person\'s own backup setting is untouched')

  t.is(await codeOf(p.fake.call('backup:configure', { folder: tmpDir('managed-other', t) })), 'MANAGED_LOCKED')
  t.is(await codeOf(p.fake.call('backup:turn-off', {})), 'MANAGED_LOCKED', 'a required backup cannot be turned off')
})

test('an unmounted share reads offline and nothing is created anywhere', async (t) => {
  const share = tmpPath('managed-share-missing')
  const p = await setup(t, { share })
  t.is(await codeOf(p.fake.call('backup:setup', { folder: p.view.backupFolder, passphrase: PASS })), 'BACKUP_TARGET_OFFLINE')
  t.absent(fs.existsSync(share), 'the share\'s base is never created')
})

test('leaving the organization brings back the person\'s own (empty) backup setting', async (t) => {
  const share = tmpDir('managed-share-leave', t)
  const p = await setup(t, { share, required: false })
  await p.fake.call('backup:setup', { folder: p.view.backupFolder, passphrase: PASS })
  await p.fake.call('managed:leave', {})
  await waitFor(async () => (await p.fake.call('backup:status', {})).folder === null, 10000, { label: 'the own setting back' })
  t.alike(p.ownSettings(), { folder: null, repoId: null })
  t.ok(fs.existsSync(p.view.backupFolder), 'the backup on the share stays')
})

test('REGRESSION (FIX-4: inherited setup): a device backing up to its own folder is not set up on the organization\'s', async (t) => {
  const share = tmpDir('managed-share-own', t)
  const peer = await freshPeer(t)
  registerManaged(peer.fake.ipc, { service: peer.root.managed })
  registerBackup(peer.fake.ipc, { backup: peer.root.backup, paused: peer.root.backupPaused, openRecovery: createPassphraseThrottle() })
  setRuntimeConfig({ ...getRuntimeConfig(), managedTestSigningKey: SIGNER.publicHex, managedAllowHttpLoopback: true, managedPreviewTimeoutMs: 1500, managedHttpsPollMs: 60_000 })
  await createSpace('Projects')
  await peer.fake.call('backup:setup', { folder: tmpDir('managed-own-folder', t), passphrase: PASS })
  const api = await startManagedConsole(t)
  const org = organization({ apiUrl: api.apiUrl })
  const settings = { [backupFolderKey(devicePlatform())]: `${share}/{user}/{install}` }
  api.set({ bundles: [{ profileId: 'p1', bytes: sealBundle({ signer: SIGNER, driveKey: org.driveKey, recipients: [org.bundlePublicKey], organization: { name: 'Acme Test GmbH' }, apiUrl: api.apiUrl, settings }) }] })
  const view = await peer.fake.call('managed:accept', { code: org.code })
  const status = await peer.fake.call('backup:status', {})
  t.is(status.folder, null, 'the organization\'s folder waits for a setup there')
  t.is(status.prompt, 'offer', 'and offers it')
  await peer.fake.call('backup:setup', { folder: view.backupFolder, passphrase: PASS })
  await waitFor(async () => (await peer.fake.call('backup:status', {})).lastSuccessAt !== null, 20000, { label: 'a backup on the organization\'s folder' })
})
