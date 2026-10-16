// How a space's download folder changes once a request naming it is accepted — from Edit Space, the
// controls-row button, or any download (download-folder-push.js checks the folder first): the
// space's record and live root move, then the folder moves to the front of this device's recent
// folders. Boot backfills old records and starts the recent list.
import { AppError, errorMessage } from '../core/errors.js'
import { CODES } from '../contract/errors.js'
import { createLogger } from '../core/logger.js'
import { getDownloadDir, isSameFolder, setRecentDownloadFolders, setSpaceDownloadRoot } from '../core/paths.js'
import { getRecentDownloadFolderLimit } from '../core/runtime-config.js'
import { getSettings, updateSettings } from '../core/settings-store.js'
import { withRecentFolder } from '../core/settings-rules.js'
import { setSpaceDownloadFolder } from '../spaces/space.js'

const log = createLogger('download-folder')

/** @param {string[]} a @param {string[]} b */
const sameList = (a, b) => a.length === b.length && a.every((p, i) => p === b[i])

// A space whose record is gone (left meanwhile) gets no live root: one would outlive the space in
// the reveal allowlist and in mount validation.
/** @param {string} spaceId @param {string} folder @returns {Promise<boolean>} whether the space's folder changed */
export async function moveSpaceDownloadFolder(spaceId, folder) {
  if (isSameFolder(getDownloadDir(spaceId), folder)) return false
  if (!await setSpaceDownloadFolder(spaceId, folder)) throw new AppError(CODES.SPACE_NOT_FOUND, 'Space not found')
  setSpaceDownloadRoot(spaceId, folder)
  return true
}

// The recent list is bookkeeping: a folder already at the front writes nothing, a broken
// settings.json is kept (settings-store.js), and a write that fails is logged and fails nothing,
// since the space's folder is what the request was about.
/** @param {string} folder @returns {Promise<boolean>} whether the list changed */
export async function pushRecentDownloadFolder(folder) {
  const opts = { limit: getRecentDownloadFolderLimit(), same: isSameFolder }
  const before = getSettings().downloads.recent
  if (sameList(before, withRecentFolder(before, folder, opts))) return false
  try {
    const { downloads } = await updateSettings((s) => {
      s.downloads.recent = withRecentFolder(s.downloads.recent, folder, opts)
      return s
    }, { keepBroken: true })
    setRecentDownloadFolders(downloads.recent)
    return !sameList(before, downloads.recent)
  } catch (err) {
    log.warn('recent download folders not saved:', errorMessage(err))
    return false
  }
}

// A record from before the folder was per space downloads where it did the day before: the app
// folder as it is set now. Runs every boot and writes only records that have no folder.
/** @param {{ spaceId: string, downloadFolder?: string }[]} spaces @param {string} seed */
export async function backfillSpaceFolders(spaces, seed) {
  for (const space of spaces) {
    if (typeof space.downloadFolder === 'string' && space.downloadFolder) continue
    await setSpaceDownloadFolder(space.spaceId, seed)
    space.downloadFolder = seed
  }
}

// The recent list starts from what the device already uses: the app folder first, then each
// space's folder. A seeded list is never empty again, so an empty one is a first boot. The list
// meets its configured length here, the first moment that length is known.
/** @param {{ downloadFolder?: string }[]} spaces @param {string} seed @returns {Promise<string[]>} */
export async function hydrateRecentDownloadFolders(spaces, seed) {
  const stored = getSettings().downloads.recent
  let recent = stored
  if (recent.length === 0) {
    for (const folder of [seed, ...spaces.map((s) => s.downloadFolder)]) {
      if (folder && !recent.some((p) => isSameFolder(p, folder))) recent = [...recent, folder]
    }
  }
  recent = recent.slice(0, getRecentDownloadFolderLimit())
  if (!sameList(stored, recent)) {
    recent = (await updateSettings((s) => { s.downloads.recent = recent; return s }, { keepBroken: true })).downloads.recent
  }
  setRecentDownloadFolders(recent)
  return recent
}
