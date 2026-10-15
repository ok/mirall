// The worker's settings: the download folder and the network caps and relay slot. One query, poked
// by the worker after every write, so a change made in another window or by another client lands
// here too.
import { useQuery } from '../store/useQuery.js'
import { SETTINGS_SCOPES } from '../store/scopes.js'

export function useSettings() {
  return useQuery('settings:get', {}, SETTINGS_SCOPES)
}

// The effective global download folder, undefined until read.
export function useDownloadFolder(): { folder: string | undefined; error: Error | null } {
  const { data, error } = useSettings()
  return { folder: data?.downloads.folder, error }
}
