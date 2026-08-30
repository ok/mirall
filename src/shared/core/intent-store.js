import { createBee } from './store.js'
import { Subsystem } from './subsystem.js'

let bee

export async function initIntents() {
  bee = createBee('intents')
  await bee.ready()
}

export function getIntentsBee() {
  if (!bee) throw new Error('intents bee not open')
  return bee
}

// A bee of its own rather than a prefix on an existing one: intents span spaces, mounts and
// transfers, so hanging them off any one of those would tie a flow's recoverability to that
// store's lifetime. Durable tier — it must outlive every runtime subsystem whose flow it records.
export class IntentsBee extends Subsystem {
  async _open() { await initIntents() }

  async _close() {
    const b = bee
    bee = undefined
    await b?.close()
  }
}
