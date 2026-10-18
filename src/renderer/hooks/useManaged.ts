// Which organization manages this install, or null on every install without an accepted license.
// The one read every managed surface derives from: a null here renders nothing anywhere.
import { useQuery } from '../store/useQuery.js'
import { MANAGED_SCOPES } from '../store/scopes.js'
import type { ManagedView } from '../../shared/contract/responses.js'

export function useManaged(): ManagedView | null {
  const { data } = useQuery('managed:get', {}, MANAGED_SCOPES)
  return data ?? null
}
