// scripts/inspect-db.mjs — read-only inspector. Quit Mirall before running.
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import os from 'os'
import path from 'path'

const dir = process.env.MIRALL_STORAGE
  || path.join(os.homedir(), 'Library/Application Support/Mirall/app-storage')

const store = new Corestore(dir)
await store.ready()

const beeNames = ['profile', 'spaces-meta', 'pending-transfers', 'downloads-meta']

for (const name of beeNames) {
  const core = store.get({ name })
  await core.ready()
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  console.log(`\n=== ${name}  (length=${core.length}) ===`)
  for await (const { key, value } of bee.createReadStream()) {
    console.log(key, '→', JSON.stringify(value))
  }
}
await store.close()