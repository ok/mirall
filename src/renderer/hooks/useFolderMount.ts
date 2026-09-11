// Owned-folder mount state and RPC wrappers (validate/preview/mount); useOwnedMount projects the
// owned-folder:list-all entry the query store already holds.
import { useMemo } from 'react'
import { request, subscribe } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { ownedMountSettled, projectOwnedMount } from '../ownedMount.js'
import { ANY_SHARES } from '../store/scopes.js'
import type { OwnedMountRow, OwnedMountState } from '../ownedMount.js'
import type { MountValidationResult, ScanPreview, PreviewProgress, Share, OwnedFolderMount } from '../types.js'

// Same store entry as useShares: one value, two projections, one fence — SpaceView's badge and
// FolderView's fault strip cannot disagree. Re-derives on the shares scope (README.md).
export function useOwnedMount(spaceId: string, shareId: string): OwnedMountState {
  const enabled = Boolean(spaceId && shareId)
  // Not `loading`: ownedMountSettled carries that reasoning, and not taking the flag at all is
  // what makes the trap unrepresentable here.
  const { data } = useQuery<OwnedMountRow[]>('owned-folder:list-all', {}, ANY_SHARES, { enabled })
  const settled = ownedMountSettled(enabled, data)
  return useMemo(
    () => projectOwnedMount(data, spaceId, shareId, settled),
    [data, spaceId, shareId, settled],
  )
}

export async function validateOwnedMount(mountPath: string, shareId?: string): Promise<MountValidationResult> {
  return (await request('owned-folder:validate', { mountPath, shareId })) as MountValidationResult
}

let previewSeq = 0

interface OwnedPreviewHandle {
  previewId: string
  result: Promise<ScanPreview>
}

export function previewOwnedMount(
  spaceId: string,
  shareId: string | null,
  mountPath: string,
  opts: { ignore?: string[]; onProgress?: (p: PreviewProgress) => void } = {},
): OwnedPreviewHandle {
  const previewId = `pv-${++previewSeq}-${spaceId}`
  const onProgress = opts.onProgress
  const off = onProgress
    ? subscribe<PreviewProgress & { previewId: string }>('event:owned-folder-preview-progress', (m) => {
      if (m.previewId === previewId) onProgress(m)
    })
    : () => {}
  const result = (request(
    'owned-folder:preview',
    { spaceId, shareId: shareId ?? null, mountPath, ignore: opts.ignore, previewId },
    0,
  ) as Promise<ScanPreview>).finally(off)
  return { previewId, result }
}

export function cancelOwnedPreview(previewId: string): void {
  void request('owned-folder:cancel-preview', { previewId }).catch(() => undefined)
}

// One worker command, not two IPCs with a compensating delete between them. The compensation used
// to live here, and a renderer reload or an app quit between the two calls skipped it entirely —
// leaving a folder advertised to every peer with nothing behind it. The worker now owns both writes
// and records a durable intent across them, so the next boot finishes what a crash interrupted.
export async function createShareThenMount(
  spaceId: string,
  name: string,
  mountPath: string,
  ignore?: string[],
) {
  return (await request('share:create-and-mount', { spaceId, name, mountPath, ignore })) as {
    share: Share
    mount: OwnedFolderMount
    advisories: { code: string; message: string }[]
  }
}
