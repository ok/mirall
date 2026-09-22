// Every write a mirror pass makes — to the mount record and to the mirror-participation record —
// goes through a writer scoped to the generation the pass started at.
//
// The rule: a pause, relocate or unmount invalidates the generation before it writes the record
// (loops.invalidate or loops.stop), and a pass writer checks its generation inside the record's
// serialized write. A pass write queued ahead of the verb's lands before it; one queued behind it
// sees the invalidation and declines. So a cancelled pass never writes after the verb that
// cancelled it, and the verb never has to tear anything down before its own write can fail.
import { mutateForeignMount } from './mount-store.js'
import { setMirrorState } from './mirror-records.js'
import { mirrorKey } from './mirror-policy.js'

export function createPassWriters(loops) {
  return function passWriter({ spaceId, shareId }, gen) {
    const key = mirrorKey(spaceId, shareId)
    const stopped = () => loops.stopped(key, gen)
    const mutate = (apply) => mutateForeignMount(spaceId, shareId, (m) => (stopped() ? null : apply(m)))
    return {
      stopped,
      mutate,
      patch: (fields) => mutate((m) => ({ ...m, ...fields })),
      setMirrorState: (state) => setMirrorState(spaceId, shareId, state, { stopped }),
    }
  }
}
