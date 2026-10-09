// Who holds a verified copy of each file we share in a space, keyed the way the file rows are. The
// store holds the cache and re-reads on the recipients scope the worker pokes on every new copy, at
// most once per window: a folder download notes a recipient per file.
import { useCallback, useMemo, useRef } from 'react'
import { useQuery } from '../store/useQuery.js'
import { indexRecipients, recipientKey, withMirrors } from '../model/file-recipients.js'
import { useSpaceMirrors } from './useSpaceMirrors.js'
import type { FileRecipient } from '../types/types.js'

const EMPTY: FileRecipient[] = []

export function useFileRecipients(spaceId: string): (path: string, shareId?: string) => FileRecipient[] {
  const { data } = useQuery('recipients:list', { spaceId }, [{ kind: 'recipients', spaceId }], { coalesceMs: 750, enabled: Boolean(spaceId) })
  const previous = useRef(new Map<string, FileRecipient[]>())
  const index = useMemo(() => (previous.current = indexRecipients(data ?? EMPTY, previous.current)), [data])
  return useCallback((path, shareId) => index.get(recipientKey(path, shareId)) ?? EMPTY, [index])
}

interface FoldedRows {
  own: FileRecipient[]
  contentHash: string
  rows: FileRecipient[]
}

// A folder's rows with its mirrors folded in (withMirrors). A row keeps its array while its own
// recipients, its hash and the mirrors are unchanged, so the memoized rows re-render only on a change.
export function useFolderRecipients(spaceId: string, shareId: string): (relPath: string, contentHash: string) => FileRecipient[] {
  const recipientsOf = useFileRecipients(spaceId)
  const mirrors = useSpaceMirrors(spaceId, shareId)
  const folded = useMemo(() => new Map<string, FoldedRows>(), [mirrors])
  return useCallback((relPath, contentHash) => {
    const own = recipientsOf(relPath, shareId)
    const hit = folded.get(relPath)
    if (hit && hit.own === own && hit.contentHash === contentHash) return hit.rows
    const rows = withMirrors(own, mirrors, relPath, contentHash)
    folded.set(relPath, { own, contentHash, rows })
    return rows
  }, [recipientsOf, shareId, mirrors, folded])
}
