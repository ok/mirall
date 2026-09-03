// Owned-folder mount state and RPC wrappers (validate/preview/mount); useOwnedMount refreshes on owned-folder-mount-status events.
import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc.js'
import type { OwnedFolderMount, MountValidationResult, ScanPreview, PreviewProgress, Share } from '../types.js'

interface MountStatusEvent {
  spaceId: string
  shareId: string
  status: string
  error?: string
}

// The badge projection of an owned mount's durable state: a live missing path wins, then
// any persisted non-healthy status (paused-error / mount-point-gone survive a restart);
// healthy states (active / scanning) render no badge. Shared by useOwnedMount and useShares
// so SpaceView and FolderView cannot drift.
export function unhealthyOwnedStatus(m: (OwnedFolderMount & { mountPointMissing?: boolean }) | null | undefined): string | null {
  if (!m) return null
  if (m.mountPointMissing) return 'mount-point-gone'
  if (m.status && m.status !== 'active' && m.status !== 'scanning') return m.status
  return null
}

// Level-triggered: every mount-status event for this share re-derives from
// owned-folder:list-all (a live mountRootAvailable disk check plus the durable
// mount.status) instead of latching msg.status — the same projection SpaceView gets
// via useShares, but from a subscriber that is actually mounted while FolderView is open.
export interface OwnedMountState {
  status: string | null
  lastError: string | null
  indexPaused: boolean
  /** The scan is walking the disk. It fills no queue, so nothing else can report that phase. */
  scanning: boolean
  mountPath: string | null
}

const NO_OWNED_MOUNT: OwnedMountState = { status: null, lastError: null, indexPaused: false, scanning: false, mountPath: null }

export function useOwnedMount(spaceId: string, shareId: string): OwnedMountState {
  const [state, setState] = useState<OwnedMountState>(NO_OWNED_MOUNT)

  useEffect(() => {
    if (!spaceId || !shareId) return
    let alive = true
    const derive = () => {
      request('owned-folder:list-all').then((mounts) => {
        if (!alive) return
        const rows = mounts as (OwnedFolderMount & { mountPointMissing?: boolean })[]
        const m = rows.find((x) => x.spaceId === spaceId && x.shareId === shareId)
        // Both from one read: the badge projection AND the durable intent behind it. The status
        // alone cannot carry the pause — a scan settle overwrites it, and 'mount-point-gone'
        // legitimately outranks it while the source is missing.
        setState({
          status: unhealthyOwnedStatus(m),
          lastError: m?.lastError ?? null,
          indexPaused: !!m?.indexPaused,
          scanning: m?.status === 'scanning',
          mountPath: m?.mountPath ?? null,
        })
      }).catch(() => {})
    }
    derive()
    const unsub = subscribe<MountStatusEvent>('event:owned-folder-mount-status', (msg) => {
      if (msg.spaceId === spaceId && msg.shareId === shareId) derive()
    })
    return () => { alive = false; unsub() }
  }, [spaceId, shareId])

  return state
}

export async function validateOwnedMount(mountPath: string, shareId?: string): Promise<MountValidationResult> {
  return (await request('owned-folder:validate', { mountPath, shareId })) as MountValidationResult
}

let previewSeq = 0

export interface OwnedPreviewHandle {
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

export async function createOwnedMount(spaceId: string, shareId: string, mountPath: string, ignore?: string[]) {
  return (await request('owned-folder:mount', { spaceId, shareId, mountPath, ignore })) as {
    mount: OwnedFolderMount
    advisories: { code: string; message: string }[]
  }
}

export async function createShareThenMount(
  spaceId: string,
  name: string,
  mountPath: string,
  ignore?: string[],
) {
  const share = (await request('share:create', { spaceId, name })) as Share
  try {
    const result = await createOwnedMount(spaceId, share.id, mountPath, ignore)
    return { share, ...result }
  } catch (err) {
    await request('share:delete', { spaceId, shareId: share.id }).catch(() => undefined)
    throw err
  }
}
