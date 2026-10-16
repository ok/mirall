// The worker's settings: the download folder for new spaces, the recent download folders, the
// network caps and relay slot, and how the worker's host writes a path. One query, poked by the
// worker after every write, so a change made in another window or by another client lands here too.
import { useQuery } from '../store/useQuery.js'
import { SETTINGS_SCOPES } from '../store/scopes.js'

export function useSettings() {
  return useQuery('settings:get', {}, SETTINGS_SCOPES)
}
