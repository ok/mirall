// Minimal external store for the What's New modal: open/close with changelog entries; the modal host subscribes.
import type { ChangelogEntry } from './changelog.js'

export type WhatsNewMode = 'update' | 'all'

export interface WhatsNewState {
  entries: ChangelogEntry[]
  mode: WhatsNewMode
}

type Listener = (state: WhatsNewState | null) => void

let state: WhatsNewState | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const cb of listeners) cb(state)
}

export function open(entries: ChangelogEntry[], mode: WhatsNewMode = 'update'): void {
  state = { entries, mode }
  emit()
}

export function close(): void {
  state = null
  emit()
}

export function subscribe(cb: Listener): () => void {
  listeners.add(cb)
  cb(state)
  return () => { listeners.delete(cb) }
}
