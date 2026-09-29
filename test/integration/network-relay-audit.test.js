import test from 'brittle'
import fs from 'bare-fs'
import crypto from 'hypercore-crypto'
import { openStore, setMasterSecret } from '../../src/shared/core/store.js'
import { initAuditLog, flushAudit, setAuditConfig } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { purgeAudit } from '../../src/shared/audit/audit-reclaim.js'
import { setRuntimeConfig, getRelayConfig } from '../../src/shared/core/runtime-config.js'
import { resetNetworkStatus } from '../../src/shared/network/network-status.js'
import { truncateRelayKey } from '../../src/shared/contract/relay-key.js'
import { registerNetwork } from '../../src/worker/ipc/network.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { tmpDir } from '../helpers/bare-tmp.js'

const KEY_A = 'yry4bqaudkr5bn9wf7pjfka1rf6m6r7yb9c4e7t5j8njbke6xk7q'
const KEY_B = 'usdgj55ym13jkwz7nyrn4tf9yog5ocqhgbzpmiapfunqoj398xqo'
const SLOT_A = { publicKey: KEY_A, kind: 'open', label: 'Hetzner', enabled: true, lastTest: null }
const SLOT_B = { publicKey: KEY_B, kind: 'open', label: '', enabled: true, lastTest: null }
const PRIVATE_SLOT = { publicKey: KEY_B, kind: 'private', label: 'Team', enabled: true, lastTest: null }

// The handler as the renderer drives it after main saved the change. applyRelayConfig is the boot
// root's; here it records what it would install from, and installs nothing.
async function boot(t) {
  const storage = tmpDir('relay-audit-store')
  t.teardown(() => {
    resetNetworkStatus()
    try { fs.rmSync(storage, { recursive: true, force: true }) } catch {}
  })
  await openStore(storage)
  setMasterSecret(crypto.randomBytes(32))
  await initAuditLog({ installId: 'install-under-test' })
  await setAuditConfig({ enabled: true, retentionDays: 90, maxEntries: 200000 })
  await purgeAudit()
  setRuntimeConfig({ relayMode: 'off', relay: null })
  const applied = []
  const fake = createFakeIpc()
  registerNetwork(fake.ipc, { applyRelayConfig: () => { applied.push(getRelayConfig()); return { applied: 0 } } })
  return { set: (msg) => fake.call('network:set-relay', msg), applied }
}

// Newest first, as the Activity Log lists them.
async function relayRows() {
  await flushAudit()
  const { entries } = await queryAudit({ limit: 200 })
  return entries.filter((e) => e.kind.startsWith('relay.'))
}

test('adding a relay records one self row naming the masked relay', async (t) => {
  const { set } = await boot(t)
  await set({ mode: 'auto', relay: SLOT_A })

  const rows = await relayRows()
  t.is(rows.length, 1, 'one row: the add, not a turned-on row beside it')
  t.is(rows[0].kind, 'relay.added')
  t.is(rows[0].actor.type, 'self')
  t.is(rows[0].category, 'network')
  t.is(rows[0].tier, 'A')
  t.alike(rows[0].target, { kind: 'relay', id: truncateRelayKey(KEY_A), name: 'Hetzner' })
  t.alike(rows[0].subject, { relayKind: 'open', mode: 'auto' })
})

test('the probe verdict the add triggers records nothing', async (t) => {
  const { set } = await boot(t)
  await set({ mode: 'auto', relay: SLOT_A })
  await set({ mode: 'auto', relay: { ...SLOT_A, lastTest: { at: Date.now(), ok: false } } })

  t.alike((await relayRows()).map((e) => e.kind), ['relay.added'])
})

test('each mode switch is one row naming the mode it switched to', async (t) => {
  const { set } = await boot(t)
  await set({ mode: 'auto', relay: SLOT_A })
  await set({ mode: 'always', relay: SLOT_A })
  await set({ mode: 'auto', relay: SLOT_A })
  await set({ mode: 'off', relay: SLOT_A })
  await set({ mode: 'always', relay: SLOT_A })

  const rows = await relayRows()
  t.alike(rows.map((e) => e.kind), ['relay.turned_on', 'relay.turned_off', 'relay.mode_changed', 'relay.mode_changed', 'relay.added'])
  t.is(rows[0].subject.mode, 'always', 'turned back on straight into always')
  t.is(rows[2].subject.mode, 'auto')
})

test('a replace names the relay it replaced, and a remove is one row', async (t) => {
  const { set } = await boot(t)
  await set({ mode: 'auto', relay: SLOT_A })
  await set({ mode: 'auto', relay: SLOT_B })
  await set({ mode: 'off', relay: null })

  const rows = await relayRows()
  t.alike(rows.map((e) => e.kind), ['relay.removed', 'relay.replaced', 'relay.added'])
  t.is(rows[1].target.name, truncateRelayKey(KEY_B), 'an unlabelled relay is named by its masked key')
  t.is(rows[1].subject.previous, truncateRelayKey(KEY_A))
  t.is(rows[1].subject.previousLabel, 'Hetzner')
  t.is(rows[0].target.name, truncateRelayKey(KEY_B))
})

// A private relay added while its pinned identity waits on the restart: the worker must know what
// was saved, so the add is recorded, while what it installs from carries the pending flag.
test('a private relay added while its identity waits on a restart is recorded, not installed', async (t) => {
  const { set, applied } = await boot(t)
  const reply = await set({ mode: 'auto', relay: PRIVATE_SLOT, deferApply: true })

  const rows = await relayRows()
  t.alike(rows.map((e) => e.kind), ['relay.added'])
  t.is(rows[0].subject.relayKind, 'private')
  t.is(applied.at(-1).identityPending, true, 'the installer is told the identity is pending')
  t.alike(applied.at(-1).relay, PRIVATE_SLOT, 'and holds the slot as saved')
  t.is(reply.reconnected, false)
})

// Only the worker restart applies a pinned identity, so the flag outlives a renderer that reloaded
// and forgot it: a later save without deferApply must not install the private relay.
test('a pending identity stays pending across later saves until the worker restarts', async (t) => {
  const { set, applied } = await boot(t)
  await set({ mode: 'auto', relay: PRIVATE_SLOT, deferApply: true })
  const reply = await set({ mode: 'always', relay: PRIVATE_SLOT })

  t.is(applied.at(-1).identityPending, true)
  t.is(reply.reconnected, false, 'no reconnect can apply the identity either')
  t.alike((await relayRows()).map((e) => e.kind), ['relay.mode_changed', 'relay.added'])
})

test('with the log disabled the relay is still applied and nothing is recorded', async (t) => {
  const { set } = await boot(t)
  await setAuditConfig({ enabled: false })
  await set({ mode: 'auto', relay: SLOT_A })

  t.alike(getRelayConfig().relay, SLOT_A, 'the setting took effect')
  await setAuditConfig({ enabled: true })
  t.is((await relayRows()).length, 0)
})

test('no row ever holds a full relay key', async (t) => {
  const { set } = await boot(t)
  await set({ mode: 'auto', relay: SLOT_A })
  await set({ mode: 'always', relay: SLOT_A })
  await set({ mode: 'always', relay: SLOT_B })
  await set({ mode: 'off', relay: null })

  const text = JSON.stringify(await relayRows())
  t.absent(text.includes(KEY_A) || text.includes(KEY_B))
})
