// Foreign (mirror) mount state and RPC wrappers (validate/preview/mount/enable/unmount); useForeignMount refreshes on foreign-folder-mount-status events.
import { useState, useEffect, useCallback } from 'react'
import { request, subscribe } from '../ipc.js'
import type { ForeignFolderMount, MountValidationResult, ScanPreview, ForeignMountStatus, PreviewProgress } from '../types.js'

interface MountStatusEvent {
  spaceId: string
  shareId: string
  status: ForeignMountStatus
  error?: string
}

export function useForeignMount(spaceId: string, shareId: string) {
  const [mount, setMount] = useState<ForeignFolderMount | null>(null)
  const [status, setStatus] = useState<ForeignMountStatus | null>(null)

  const refresh = useCallback(async () => {
    if (!spaceId || !shareId) return
    const m = (await request('foreign-folder:get', { spaceId, shareId })) as ForeignFolderMount | null
    setMount(m)
    setStatus(m?.status ?? null)
  }, [spaceId, shareId])

  useEffect(() => {
    refresh()
    const unsub = subscribe<MountStatusEvent>('event:foreign-folder-mount-status', (msg) => {
      if (msg.spaceId !== spaceId || msg.shareId !== shareId) return
      setStatus(msg.status)
      // Re-read the durable record on EVERY transition (paused states persist too), so
      // `mount` (enabled/status) can never go stale on a missed recovery event.
      refresh()
    })
    return unsub
  }, [refresh, spaceId, shareId])

  return { mount, status, refresh }
}

export async function validateForeignMount(mountPath: string, shareId?: string): Promise<MountValidationResult> {
  return (await request('foreign-folder:validate', { mountPath, shareId })) as MountValidationResult
}

let foreignPreviewSeq = 0

export interface ForeignPreviewHandle {
  previewId: string
  result: Promise<ScanPreview>
}

export function previewForeignMount(
  spaceId: string,
  ownerKey: string,
  shareId: string,
  mountPath: string,
  opts: { onProgress?: (p: PreviewProgress) => void } = {},
): ForeignPreviewHandle {
  const previewId = `fpv-${++foreignPreviewSeq}-${spaceId}`
  const onProgress = opts.onProgress
  const off = onProgress
    ? subscribe<PreviewProgress & { previewId: string }>('event:foreign-folder-preview-progress', (m) => {
        if (m.previewId === previewId) onProgress(m)
      })
    : () => {}
  const result = (request(
    'foreign-folder:preview',
    { spaceId, ownerKey, shareId, mountPath, previewId },
    0,
  ) as Promise<ScanPreview>).finally(off)
  return { previewId, result }
}

export function cancelForeignPreview(previewId: string): void {
  void request('foreign-folder:cancel-preview', { previewId }).catch(() => undefined)
}

export async function createForeignMount(spaceId: string, ownerKey: string, shareId: string, mountPath: string) {
  return (await request('foreign-folder:mount', { spaceId, ownerKey, shareId, mountPath })) as {
    mount: ForeignFolderMount
    advisories: { code: string; message: string }[]
  }
}

export async function setForeignMountEnabled(spaceId: string, shareId: string, enabled: boolean) {
  return (await request('foreign-folder:set-enabled', { spaceId, shareId, enabled })) as ForeignFolderMount
}

export async function unmountForeignMount(spaceId: string, shareId: string) {
  await request('foreign-folder:unmount', { spaceId, shareId })
}
