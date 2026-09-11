// Foreign (mirror) mount state and RPC wrappers (validate/preview/mount/enable/unmount);
// useForeignMount reads the durable record through the query store.
import { useMemo } from 'react'
import { request, subscribe } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { sharesScope } from '../store/scopes.js'
import type { ForeignFolderMount, MountValidationResult, ScanPreview, ForeignMountStatus, PreviewProgress } from '../types.js'

// Re-derives on the SHARES scope — that is where the worker maps mount-status transitions (README.md).

// The params are part of the entry key: an unmounted mirror (shareId '') is a DIFFERENT entry, so a
// stale mount cannot survive an unmount or a share switch.
export function useForeignMount(spaceId: string, shareId: string) {
  const enabled = Boolean(spaceId && shareId)
  const scopes = useMemo(() => sharesScope(spaceId), [spaceId])
  const { data } = useQuery<ForeignFolderMount | null>('foreign-folder:get', { spaceId, shareId }, scopes, { enabled })

  // Not `data ?? null` unconditionally: a disabled entry has never been fetched, and its undefined
  // must read as "no mount" rather than as whatever the last enabled render held.
  const mount = enabled ? (data ?? null) : null
  return { mount, status: (mount?.status ?? null) as ForeignMountStatus | null }
}

export async function validateForeignMount(mountPath: string, shareId?: string): Promise<MountValidationResult> {
  return (await request('foreign-folder:validate', { mountPath, shareId })) as MountValidationResult
}

let foreignPreviewSeq = 0

interface ForeignPreviewHandle {
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
