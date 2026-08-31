// A space's loose-file listing, read through the query store, plus the optimistic rows a publish
// shows before the worker has indexed the file.
import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { request, addFileToSpace } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { refetchQuery } from '../store/query-store.js'
import { mergeOptimistic } from '../optimisticRows.js'
import { useToast } from '../components/toast/useToast.js'
import { errorCodeToI18nKey } from '../errorMessages.js'
import type { FileEntry } from '../types.js'

const EMPTY: FileEntry[] = []

// A members change (a peer's catalog key committed post-handshake) can newly reveal that peer's
// loose files, so the listing re-derives on it too — the handshake's pre-persist files hint races
// the member persist, but the post-persist members poke does not.
function filesScopes(spaceId: string) {
  return [{ kind: 'files', spaceId }, { kind: 'members', spaceId }]
}

export function useFiles(spaceId: string) {
  const toast = useToast()
  const { t: tErr } = useTranslation('errors')
  const [uploadingFiles, setUploadingFiles] = useState<Map<string, FileEntry>>(new Map())

  // One leading + one trailing files:list per 750 ms window: a publish emits one files hint per
  // catalog append and a handshake emits a members poke AND a files hint, neither of which should
  // become concurrent full fan-outs.
  const { data, error: queryError, loading: fetching } = useQuery<FileEntry[]>(
    'files:list',
    { spaceId },
    filesScopes(spaceId),
    { coalesceMs: 750, enabled: Boolean(spaceId) },
  )

  const files = data ?? EMPTY
  // Only a genuinely cold space shows "Loading files…". A hint-driven refetch keeps the rows on
  // screen, which is what stops the list collapsing and resetting scroll.
  const loading = data === undefined && fetching
  // The rows survive a failed read; the message is surfaced beside them and clears on the next
  // successful one.
  const error = queryError ? queryError.message : null

  const refresh = useCallback(async () => {
    if (!spaceId) return
    await refetchQuery<FileEntry[]>('files:list', { spaceId }, filesScopes(spaceId)).catch(() => {})
  }, [spaceId])

  async function addFiles(fileList: File[]) {
    for (const file of fileList) {
      const path = '/' + file.name

      setUploadingFiles(prev => {
        const next = new Map(prev)
        next.set(path, {
          path,
          size: file.size,
          hash: 'pending:' + path,
          owner: { displayName: 'You', publicKey: '' },
          driveKey: '',
          localBytes: 0,
          isAvailable: true,
          status: 'publishing',
        })
        return next
      })

      try {
        await addFileToSpace(spaceId, file)
      } catch (err) {
        const code = (err as { code?: string } | null)?.code
        toast.error(tErr(errorCodeToI18nKey(code)))
      } finally {
        setUploadingFiles(prev => {
          const next = new Map(prev)
          next.delete(path)
          return next
        })
      }
    }
  }

  async function downloadFile(file: FileEntry) {
    return await request('files:download', {
      spaceId,
      driveKey: file.driveKey,
      path: file.path,
      inPlace: file.inPlace ?? false,
      ownerKey: file.owner.publicKey,
    })
  }

  async function unshareFile(path: string) {
    await request('files:remove', { spaceId, path })
  }

  async function discardPartial(file: FileEntry) {
    await request('files:discard-partial', { spaceId, path: file.path, inPlace: file.inPlace ?? false })
  }

  async function cancelPublish(path: string) {
    await request('files:cancel-publish', { spaceId, path })
  }

  async function revealFile(path: string) {
    await request('files:reveal', { spaceId, path })
  }

  const allFiles = useMemo(
    () => mergeOptimistic(files, [...uploadingFiles.values()]),
    [files, uploadingFiles],
  )

  return {
    files: allFiles,
    loading,
    error,
    addFiles,
    downloadFile,
    unshareFile,
    discardPartial,
    cancelPublish,
    revealFile,
    refresh,
  }
}
