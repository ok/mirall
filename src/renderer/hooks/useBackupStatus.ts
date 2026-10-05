// The backup's status, refreshed whenever the backup service pokes the storage scope.
import { useQuery } from '../store/useQuery.js'

const BACKUP_SCOPES = [{ kind: 'storage' }]

export function useBackupStatus() {
  return useQuery('backup:status', {}, BACKUP_SCOPES).data
}
