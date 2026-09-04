// The paused-transfer markers a producer leaves behind, and the "tell the holder we stopped"
// protocol that goes with them. Shared by the download engine and the mirror loop.
//
// A pause releases the in-flight fetch slot while the holder is still showing us as paused, so the
// hash has to outlive the slot: without it a later unmount/discard cannot notify the holder, and
// its "who is downloading" row stays paused until the idle sweep.
//
// `notify` and `supersede` stay separate primitives rather than one `stop`, because the two
// producers order them differently on purpose: the mirror forgets the marker as it notifies, while
// the engine notifies first and only forgets after the durable row is cleared — a failed clear
// there must not drop a marker whose absence would auto-resume a transfer the user paused.
export function createPausedHolders ({ notifyStopped }) {
  const byKey = new Map()

  return {
    // A slot released by a PAUSE. `contentHash` may be null: a pause with no live transfer still
    // records the intent, it just has no holder to tell.
    remember (key, contentHash) { byKey.set(key, contentHash ?? null) },
    // Is this key marked paused? The engine reads this as the user's intent, which outranks every
    // automatic resume.
    has (key) { return byKey.has(key) },
    peek (key) { return byKey.get(key) ?? null },
    // Tell the holder we stopped, if a pause left it showing us paused. Leaves the marker.
    // Returns whether a notification actually went out.
    notify (key) {
      const hash = byKey.get(key)
      if (!hash) return false
      try { notifyStopped(hash) } catch { return false }
      return true
    },
    // A fresh or resumed fetch, or a completed teardown, supersedes the marker.
    supersede (key) { byKey.delete(key) },
    // Notify and forget in one step, for a producer with no durable row to clear in between.
    stop (key) {
      const notified = this.notify(key)
      byKey.delete(key)
      return notified
    },
    clear () { byKey.clear() },
  }
}
