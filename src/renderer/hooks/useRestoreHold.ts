// The restore's hold, as the controls ask it: whether the profile can be written, and whether a space
// can be shared into. Read through the same entry as the identity gate, pushed on every change.
import { useQuery } from '../store/useQuery.js'
import { RESTORE_SCOPES } from '../store/scopes.js'
import { restoreHoldView } from '../model/restore-hold-view.js'

export function useRestoreHold() {
  const { data } = useQuery('identity:status', {}, RESTORE_SCOPES)
  return restoreHoldView(data?.restore ?? null)
}
