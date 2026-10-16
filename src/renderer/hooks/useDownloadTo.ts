// One space's Download-to state: its folder, the menu every Download-to control opens, and the two
// ways to change the folder. A pick that downloads hands its folder to the download request, and the
// worker makes it the space's; a pick that only changes the folder goes through space:update.
// Choose Folder… opens the system picker at the current folder. The toast that names a new folder
// is DownloadToToastBridge's. A folder shown as not connected is re-probed when the user acts on
// it — the menu opening, the strip's inert main half clicked — so a drive plugged back in is
// offered at once rather than after the worker's next probe.
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { useSettings } from './useSettings.js'
import { useDownloadRootStatus } from './useDownloadRootStatus.js'
import { useRunAction } from './useRunAction.js'
import { copyPlace, folderChoices, type FolderChoice, type HostPaths } from '../model/download-folders.js'
import { lastSegment } from '../../shared/contract/paths.js'
import type { ActionMenuItemConfig } from '../components/primitives/ActionMenu.js'
import type { TFunction } from 'i18next'
import type { FileStatus, Space } from '../types/types.js'

/** What every Download-to menu shares, whatever opens it: spread into an ActionMenu. */
export interface DownloadMenuProps {
  heading: string
  popupWidthClass: string
  /** The folders, current first and checked, then Choose Folder…. */
  items: ActionMenuItemConfig[]
  onOpen?: () => void
}

export type DownloadMenu = (onPick: (folder: string) => void) => DownloadMenuProps

export interface DownloadTo {
  /** The space's folder; null until the space and the worker's path rules are known. */
  current: FolderChoice | null
  /** The Download-to menu; a pick hands its folder to `onPick`. */
  menu: DownloadMenu
  /** Makes `folder` the space's folder, downloading nothing. */
  setFolder: (folder: string) => void
  /** Asks the worker to look at the folders again: the user acted on one shown as not connected. */
  recheck: () => void
  /** The sentence naming `folder` as the space's new folder, for a batch the worker says moved it. */
  movedText: (folder: string) => string | null
  /** Where a row's copy is, when that is worth saying: outside the space's folder, or unplugged. */
  rowPlace: (row: { status: FileStatus, localPath: string | null }) => string | null
}

const NO_FOLDERS: readonly string[] = []
const MENU_WIDTH = 'min-w-[17rem] max-w-[22rem]'

// Every answer from the worker is a fresh object, so the memos below key on values: a list as one
// string (no path holds a NUL), the host by its fields. An answer that changes nothing then keeps
// this hook's identity, and with it every memoised row that receives it.
const SEP = '\0'
const listKey = (list: readonly string[]) => list.join(SEP)
const listOf = (key: string): readonly string[] => (key ? key.split(SEP) : NO_FOLDERS)

// One toast per space: a folder change, and a batch's outcome after it, replace each other.
export const downloadToToastId = (spaceId: string) => 'download-to:' + spaceId

export function folderMovedText(t: TFunction, spaceName: string, folder: string, host: HostPaths): string {
  return t('downloadTo.changed', { space: spaceName, folder: lastSegment(folder, host.sep) })
}

export function useDownloadTo(space: Space | undefined): DownloadTo {
  const { t } = useTranslation()
  const run = useRunAction()
  const { data: settings } = useSettings()
  const { unavailable, refresh } = useDownloadRootStatus({ passive: true })
  const { home, sep, caseFolds } = settings?.hostPaths ?? {}
  const host = useMemo<HostPaths | undefined>(
    () => (home !== undefined && sep !== undefined && caseFolds !== undefined ? { home, sep, caseFolds } : undefined),
    [home, sep, caseFolds],
  )
  const recentKey = listKey(settings?.downloads.recent ?? NO_FOLDERS)
  const unavailableKey = listKey(unavailable)
  const spaceId = space?.spaceId
  const folder = space?.downloadFolder

  const choices = useMemo(
    () => (folder && host ? folderChoices({ current: folder, recent: listOf(recentKey), unavailable: listOf(unavailableKey), host }) : []),
    [folder, recentKey, unavailableKey, host],
  )
  const current = choices[0] ?? null
  const recheck = useCallback(() => run(refresh), [run, refresh])
  const anyOffline = choices.some((c) => c.offline)

  const menu = useCallback<DownloadMenu>((onPick) => ({
    heading: t('downloadTo.heading'),
    popupWidthClass: MENU_WIDTH,
    onOpen: anyOffline ? recheck : undefined,
    items: [...choices.map((c): ActionMenuItemConfig => ({
      id: 'folder:' + c.path,
      label: c.name,
      description: c.offline ? t('downloadTo.offlinePath', { path: c.shown }) : c.shown,
      icon: c.current ? 'check' : 'folder',
      checked: c.current,
      disabled: c.offline,
      onAction: () => onPick(c.path),
    })), {
      id: 'choose',
      label: t('downloadTo.choose'),
      icon: 'folder_open',
      separatorBefore: true,
      onAction: () => run(async () => {
        const picked = await window.bridge.browseDownloadFolder(folder)
        if (picked) onPick(picked)
      }),
    }],
  }), [choices, anyOffline, recheck, t, run, folder])

  const setFolder = useCallback((next: string) => {
    if (!spaceId) return
    run(() => request('space:update', { spaceId, downloadFolder: next }))
  }, [run, spaceId])

  const spaceName = space?.name
  const movedText = useCallback(
    (next: string) => (spaceName === undefined || !host ? null : folderMovedText(t, spaceName, next, host)),
    [spaceName, host, t],
  )

  const rowPlace = useCallback((row: { status: FileStatus, localPath: string | null }) => {
    const place = folder ? copyPlace(row, folder, host) : null
    if (!place) return null
    return t(place.kind === 'detached' ? 'file.savedTo' : 'file.inFolder', { path: place.shown })
  }, [folder, host, t])

  return useMemo(
    () => ({ current, menu, setFolder, recheck, movedText, rowPlace }),
    [current, menu, setFolder, recheck, movedText, rowPlace],
  )
}
