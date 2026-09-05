// Foreign (mirror) mount state and RPC wrappers (validate/preview/mount/enable/unmount);
// useForeignMount reads the durable record through the query store.
import { useMemo } from 'react'
import { request, subscribe } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { sharesScope } from '../store/scopes.js'
import type { ForeignFolderMount, MountValidationResult, ScanPreview, ForeignMountStatus, PreviewProgress } from '../types.js'

// The scope foreign mount-status transitions actually carry: event:foreign-folder-mount-status is
// mapped to the SHARES scope worker-side, not the mirrors one. The mount is still level-triggered
// on every transition (paused states persist too), so the record can never go stale on a missed
// recovery event — the difference is that the store, not this hook, owns the re-read.

// The params are part of the entry key, so an unmounted mirror — shareId '' — is a DIFFERENT entry
// rather than the same entry holding a stale value. That is what closes the bug the hand-rolled
// version had: its early return left `mount` and `status` untouched, so FolderView went on
// rendering a paused-enospc fault strip, Retry button and all, for a mount that had already been
// unmounted. The same key separation is what stops share A's fault from painting under share B's
// header when A's read resolves after the navigation.
export function useForeignMount(spaceId: string, shareId: string) {
  const enabled = Boolean(spaceId && shareId)
  const scopes = useMemo(() => sharesScope(spaceId), [spaceId])
  const { data } = useQuery<ForeignFolderMount | null>('foreign-folder:get', { spaceId, shareId }, scopes, { enabled })

  // No refresh escape hatch. The hand-rolled version exported one and nothing ever called it: the
  // mutations that would need it (set-enabled, unmount) already emit a mount-status event, and that
  // is the shares-scoped hint the store re-reads on.
  //
  // Not `data ?? null` unconditionally: a disabled entry has never been fetched, and its undefined
  // must read as "no mount" rather than as whatever the last enabled render held.
  const mount = enabled ? (data ?? null) : null
  return { mount, status: (mount?.status ?? null) as ForeignMountStatus | null }
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
