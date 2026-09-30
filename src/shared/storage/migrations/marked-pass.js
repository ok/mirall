// A one-time migration gated by a marker in the app-migrations bee. A pass already marked is
// skipped. `pass(store, flagBee)` answers { marker, result }: the fields recorded with the marker, or
// null to leave it unwritten so the pass runs again at the next boot, and the result to return. A
// throw leaves the marker unwritten too and reads as deferred.
import { migrationResult, MIGRATION_STATUS } from './migration-result.js'
import { getStore, createLocalBee } from '../../core/store.js'

export async function runMarkedPass(flag, pass, log) {
  const flagBee = createLocalBee('app-migrations')
  try {
    const store = getStore()
    await store.ready()
    await flagBee.ready()
    if ((await flagBee.get(flag))?.value?.completedAt) return migrationResult(MIGRATION_STATUS.SKIPPED)
    const { marker, result } = await pass(store, flagBee)
    if (marker) await flagBee.put(flag, { completedAt: Date.now(), ...marker })
    return result
  } catch (err) {
    log.warn('deferred to the next boot:', err.message)
    return migrationResult(MIGRATION_STATUS.DEFERRED)
  } finally {
    try { await flagBee.close() } catch {}
  }
}
