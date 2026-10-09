// Who holds a verified copy of each file we share in a space, keyed the way the file rows are. The
// store holds the cache and re-reads on the recipients scope the worker pokes on every new copy, at
// most once per window: a folder download notes a recipient per file.
import { useCallback, useMemo, useRef } from 'react'
import { useQuery } from '../store/useQuery.js'
import { indexRecipients, recipientKey } from '../model/file-recipients.js'
import type { FileRecipient } from '../types/types.js'

const EMPTY: FileRecipient[] = []

export function useFileRecipients(spaceId: string): (path: string, shareId?: string) => FileRecipient[] {
  const { data } = useQuery('recipients:list', { spaceId }, [{ kind: 'recipients', spaceId }], { coalesceMs: 750, enabled: Boolean(spaceId) })
  const previous = useRef(new Map<string, FileRecipient[]>())
  const index = useMemo(() => (previous.current = indexRecipients(data ?? EMPTY, previous.current)), [data])
  return useCallback((path, shareId) => index.get(recipientKey(path, shareId)) ?? EMPTY, [index])
}
