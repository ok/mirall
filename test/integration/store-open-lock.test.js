import test from 'brittle'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore } from '../../src/shared/core/store.js'

function tmp (label) {
  const dir = path.join(os.tmpdir(), `store-lock-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// The lock is exclusive per open file description, so a second Corestore on the same path
// conflicts with the first even inside one process — which is what a reboot-in-place is.
test('REGRESSION (FIX-255): a re-open waits out a device lock the predecessor still holds', async (t) => {
  const root = tmp('race')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const storagePath = path.join(root, 'app-storage')

  const holder = await openStore(storagePath)
  const released = new Promise((resolve) => setTimeout(() => resolve(holder.close()), 120))

  const reopened = await openStore(storagePath)
  await released

  t.is(getStore(), reopened, 'the module hands out the re-opened store')
  t.ok(reopened.opened, 'which is open, not a store whose ready() rejected')
  await reopened.close()
})

test('REGRESSION (FIX-255): a lock nobody releases fails by name instead of hanging', async (t) => {
  const root = tmp('held')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const storagePath = path.join(root, 'app-storage')

  const holder = await openStore(storagePath)
  t.teardown(() => holder.close())

  await t.exception(() => openStore(storagePath), /storage is locked by another process/,
    'the failure names the condition and the path')
})
