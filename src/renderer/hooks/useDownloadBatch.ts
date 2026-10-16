// The batches the user started this session, keyed by listing, so the progress strip and its
// Cancel All can address the set. A second Download on the same listing merges into the one
// strip. View state: not persisted, and dropped with the space it belongs to.
import { useSyncExternalStore } from 'react'

export interface DownloadBatch {
  keys: readonly string[]
  startedAt: number
}

/** How long after a start every selected row still counts as live, before the listing has re-derived it. */
export const BATCH_START_GRACE_MS = 5000

const store = new Map<string, DownloadBatch>()
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function batchScope(spaceId: string, shareId: string | null): string {
  return shareId ? `share:${spaceId}:${shareId}` : `space:${spaceId}`
}

function spaceOf(scopeKey: string): string {
  return scopeKey.split(':')[1] ?? ''
}

// The grace window ends with a render of its own, so a strip whose rows never started goes
// without waiting for an unrelated re-render.
let graceTimer: ReturnType<typeof setTimeout> | null = null

export function startDownloadBatch(scopeKey: string, keys: readonly string[]): void {
  const prev = store.get(scopeKey)
  const merged = prev ? [...new Set([...prev.keys, ...keys])] : [...keys]
  store.set(scopeKey, { keys: merged, startedAt: Date.now() })
  if (graceTimer) clearTimeout(graceTimer)
  graceTimer = setTimeout(() => { graceTimer = null; emit() }, BATCH_START_GRACE_MS + 50)
  emit()
}

/** Whether a batch is still inside its start window. */
export function batchIsRecent(batch: DownloadBatch): boolean {
  return Date.now() - batch.startedAt < BATCH_START_GRACE_MS
}

export function clearDownloadBatch(scopeKey: string): void {
  if (!store.delete(scopeKey)) return
  emit()
}

export function pruneDownloadBatches(liveSpaceIds: Iterable<string>): void {
  const live = new Set(liveSpaceIds)
  let changed = false
  for (const key of [...store.keys()]) {
    if (live.has(spaceOf(key))) continue
    store.delete(key)
    changed = true
  }
  if (changed) emit()
}

export function useDownloadBatch(scopeKey: string): DownloadBatch | null {
  return useSyncExternalStore(subscribe, () => store.get(scopeKey) ?? null)
}
