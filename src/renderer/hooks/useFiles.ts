// Owns a space's loose-file listing (stale-while-revalidate cache, latest-wins + coalesced refreshes) plus publish/prepare progress; re-derives on event:reconcile.
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { request, subscribe, addFileToSpace } from '../ipc.js'
import { makeCoalescer } from '../coalesce.js'
import { useToast } from '../components/toast/useToast.js'
import { errorCodeToI18nKey } from '../errorMessages.js'
import { Scope, scopeMatches, type Scope as ScopeType } from '../scope.js'
import type { FileEntry } from '../types.js'

// Last-known listing per space, kept across mounts and space switches. Lets a
// reopened space render its files instantly (stale-while-revalidate) instead of
// flashing "Loading files…" while files:list drains peer drives again — the
// fresh result then quietly replaces the cached one.
const listingCache = new Map<string, FileEntry[]>()

export function useFiles(spaceId: string) {
  const toast = useToast()
  const { t: tErr } = useTranslation('errors')
  const [files, setFiles] = useState<FileEntry[]>(() => listingCache.get(spaceId) ?? [])
  const [loading, setLoading] = useState(() => !listingCache.has(spaceId))
  const [error, setError] = useState<string | null>(null)
  const [uploadingFiles, setUploadingFiles] = useState<Map<string, FileEntry>>(new Map())
  const seqRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!spaceId) return
    // Latest-wins guard (mirrors useShareFiles): files:list reads bound each peer catalog to a
    // ~1.5s budget and IPC resolves concurrently, so a slow refresh can return AFTER a newer one.
    // Without this a stale snapshot overwrites fresh rows (and poisons listingCache), reverting an
    // actively-downloading/available file back to its pre-replication state.
    const seq = ++seqRef.current
    // `files:list` can reject (IPC timeout, worker churn while the user moves
    // source files around). Without this guard the rejection is uncaught and
    // `setLoading(false)` never runs, wedging the view on "Loading files…"
    // forever. Mirror the useShareFiles contract: surface the error, keep the
    // last-known list, and let a later event-driven refresh clear it.
    try {
      const data = await request('files:list', { spaceId }) as FileEntry[]
      if (seq !== seqRef.current) return
      listingCache.set(spaceId, data)
      setFiles(data)
      setError(null)
    } catch (err) {
      if (seq !== seqRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [spaceId])

  useEffect(() => {
    if (!spaceId) return
    // Stale-while-revalidate: if we've listed this space before, show that
    // listing immediately and revalidate quietly. Only a genuinely cold space
    // (never listed) shows "Loading files…". Event-driven refreshes below never
    // flip loading either — that would collapse the list and reset scroll.
    const cached = listingCache.get(spaceId)
    if (cached) {
      setFiles(cached)
      setLoading(false)
    } else {
      setFiles([])
      setLoading(true)
    }
    setError(null)
    // One leading + one trailing files:list per 750 ms window (the coalescer useShareFiles and
    // useSpaceStorage run): a publish emits one files hint per catalog append and a handshake
    // emits a members poke AND a files hint, neither of which should become concurrent full
    // fan-outs. The first trigger fires immediately, so the initial load is not delayed.
    const coalescer = makeCoalescer(() => { void refresh() }, { intervalMs: 750 })
    coalescer.trigger()
    // Level-triggered: re-derive on the coalesced reconcile hint for this space (emitted 1:1 with
    // the files-updated poke). A lost hint self-corrects on the next one; the list is always
    // a projection of the worker's files:list, never a client-latched status.
    const unsubFiles = subscribe<{ scope: ScopeType }>('event:reconcile', (msg) => {
      // A members change (a peer's catalog key committed post-handshake) can newly reveal that
      // peer's loose files, so re-derive on it too — the handshake's pre-persist files hint races
      // the member persist, but the post-persist members poke does not.
      if (scopeMatches(msg.scope, Scope.files(spaceId)) || scopeMatches(msg.scope, Scope.members(spaceId))) coalescer.trigger()
    })
    return () => { coalescer.cancel(); unsubFiles() }
  }, [spaceId, refresh])

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

  // Drop an optimistic publishing row once the server list surfaces the same path
  // (the worker advertises the still-hashing file, so listFiles carries it) — avoids
  // a duplicate row, and the server row survives a remount where uploadingFiles can't.
  const optimistic = [...uploadingFiles.values()].filter((u) => !files.some((f) => f.path === u.path))
  const allFiles = [...optimistic, ...files]

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
