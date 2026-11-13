// Which organization manages this install, or null on every install without an accepted license.
// The one read every managed surface derives from: a null here renders nothing anywhere.
import { useQuery } from '../store/useQuery.js'
import { MANAGED_SCOPES } from '../store/scopes.js'
import type { ManagedView } from '../../shared/contract/responses.js'

export function useManaged(): ManagedView | null {
  return useManagedEntry() ?? null
}

// The same read with "not answered yet" (undefined) kept apart from "unmanaged" (null), for a
// screen that leaves when the install is not managed and must not leave while it is still asking.
export function useManagedEntry(): ManagedView | null | undefined {
  const { data } = useQuery('managed:get', {}, MANAGED_SCOPES)
  return data
}
