// Every transfer on this device, grouped by space. A download's status change pokes its space's
// listings, so the list re-derives on every listing hint in any space; a file starting or ceasing
// to be sent pokes the transfers scope itself.
import { useQuery } from '../store/useQuery.js'
import { TRANSFERS_SCOPES } from '../store/scopes.js'
import type { TransferSpace } from '../../shared/contract/responses.js'

const NONE: TransferSpace[] = []

export function useTransfers(): TransferSpace[] {
  const { data } = useQuery('transfers:list', {}, TRANSFERS_SCOPES, { coalesceMs: 250 })
  return data ?? NONE
}
