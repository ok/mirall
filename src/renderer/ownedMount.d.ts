import type { OwnedFolderMount } from './types.js'

export type OwnedMountRow = OwnedFolderMount & { mountPointMissing?: boolean }

export interface OwnedMountState {
  status: string | null
  lastError: string | null
  /** The first read has landed. `status: null` means healthy only once this is true — before it,
   *  it means "not read yet", and a caller that cannot tell them apart falls back to a frozen
   *  navigation snapshot forever. */
  loaded: boolean
  indexPaused: boolean
  /** The scan is walking the disk. It fills no queue, so nothing else can report that phase. */
  scanning: boolean
  mountPath: string | null
}

export function unhealthyOwnedStatus(m: OwnedMountRow | null | undefined): string | null
export function ownedMountSettled(enabled: boolean, rows: OwnedMountRow[] | undefined): boolean
export function projectOwnedMount(
  rows: OwnedMountRow[] | undefined,
  spaceId: string,
  shareId: string,
  settled: boolean,
): OwnedMountState
export const NO_OWNED_MOUNT: OwnedMountState
