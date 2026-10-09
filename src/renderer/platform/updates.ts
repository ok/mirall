import { UPDATE_STATE, type UpdateStatus } from '../../shared/contract/update-status.js'
import { initialUpdateState, reduceDismissed, reduceStatus, type UpdateViewState } from './update-state.js'

type Listener = (state: UpdateViewState) => void

let state: UpdateViewState = initialUpdateState
let pushed = false
const listeners = new Set<Listener>()

function emit(): void {
  for (const cb of listeners) cb(state)
}

function apply(status: UpdateStatus): void {
  // A source build loads the renderer from disk, so a staged update is applied by reloading.
  if (window.bridge.isDev() && status.state === UPDATE_STATE.READY && state.status.state !== UPDATE_STATE.READY) {
    location.reload()
    return
  }
  state = reduceStatus(state, status)
  emit()
}

if (typeof window !== 'undefined' && typeof window.bridge !== 'undefined') {
  window.bridge.onUpdateStatus((status) => {
    pushed = true
    apply(status)
  })
  window.bridge.getUpdateStatus()
    .then((status) => { if (!pushed) apply(status) })
    .catch((err) => console.error('update status read failed:', err))
}

export function getUpdateState(): UpdateViewState {
  return state
}

export function onUpdateState(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function dismissUpdate(): void {
  const next = reduceDismissed(state)
  if (next === state) return
  state = next
  emit()
}

export async function checkForUpdate(): Promise<void> {
  await window.bridge.checkForUpdate()
}

export function restartToUpdate(): Promise<boolean> {
  return window.bridge.relaunch()
}
