// Mount-target validation: refuses dangerous mount paths — system folders, the
// app's own storage, personal roots (~, Desktop, …), cloud-sync folders, Windows
// reserved names, overlaps with existing mounts, and any overlap with a download
// root — then probes writability. The async and sync variants apply the same rules;
// both also return non-blocking advisories to surface to the user.
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { AppError, ErrorCodes } from '../core/errors.js'
import { getStoragePath } from '../core/store.js'
import { listDownloadRoots } from '../core/paths.js'
import { listAllMounts } from './mount-store.js'
import { createLogger } from '../core/logger.js'
import {
  systemRootViolation, personalRootViolation, isWindowsReservedName, pathsOverlap, cloudSyncHint,
  overlapAllowed, pathContains,
} from './path-keys.js'

const log = createLogger('mount-validate')

function normalizePath(absPath) {
  const resolved = path.resolve(absPath)
  return os.platform() === 'darwin' ? resolved.normalize('NFC') : resolved
}

function overlaps(a, b) {
  return pathsOverlap(a, b, path.sep)
}

// Case-folding filesystems where a hand-typed `~/documents` resolves to the same
// folder as `~/Documents` — so personal-root equality must compare case-insensitively.
function caseInsensitive(platform) {
  return platform === 'darwin' || platform === 'win32'
}

// Shared by both validators so their rules can't drift apart: reject Windows
// reserved device names, illegal path characters, and trailing space/dot in any
// segment.
function checkWindowsSegments(normalized, platform) {
  if (platform !== 'win32') return
  for (const seg of normalized.split(path.sep)) {
    if (!seg) continue
    if (isWindowsReservedName(seg)) {
      throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_WIN_RESERVED, seg)
    }
    if (/[<>:"|?*\x00-\x1f]/.test(seg.slice(2))) {
      throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_WIN_RESERVED, seg)
    }
    if (seg.endsWith(' ') || seg.endsWith('.')) {
      throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_WIN_RESERVED, seg)
    }
  }
}

function writeProbe(dir) {
  const probe = path.join(dir, '.mirall-write-probe-' + Date.now())
  try {
    fs.mkdirSync(dir, { recursive: true })
    const fd = fs.openSync(probe, 'w')
    fs.writeSync(fd, 'probe')
    try { fs.fsyncSync(fd) } catch {}
    fs.closeSync(fd)
    fs.renameSync(probe, probe + '.r')
    fs.unlinkSync(probe + '.r')
    return true
  } catch (err) {
    // Both names: the failure may have landed after the rename, and a stranded probe file
    // in a folder we then REFUSE is litter the user can neither explain nor find.
    for (const leftover of [probe, probe + '.r']) {
      try { fs.unlinkSync(leftover) } catch {}
    }
    log.debug('write probe failed for', dir, '-', err.message)
    return false
  }
}

// A mount and a download root must never overlap, in either direction and for either role:
// downloads landing inside an OWNED folder are picked up by its watcher and published to
// peers, and a mirrored tree intermixed with flat downloads (either nesting) leaves the user
// unable to tell their own downloads from peer content. Every root counts, not just the
// global one. The mirror image of this rule lives in validateDownloadFolderAgainstMounts — both
// orders of the same two operations have to be refused, or the hazard is simply reachable
// by doing them the other way round.
function rejectIfOverlapsAnyDownloadRoot (normalized, role) {
  if (role !== 'foreign-folder' && role !== 'owned-folder') return
  const fold = caseInsensitive(os.platform())
  for (const dl of listDownloadRoots()) {
    if (pathContains(dl, normalized, path.sep, fold)) {
      throw new AppError(ErrorCodes.MOUNT_INSIDE_DOWNLOADS, dl)
    }
    if (pathContains(normalized, dl, path.sep, fold)) {
      throw new AppError(ErrorCodes.MOUNT_CONTAINS_DOWNLOADS, dl)
    }
  }
}

// The download-folder side of the same invariant. Two spaces sharing one download folder is
// the default state and stays allowed. Every rejection runs BEFORE the write probe: probing
// first would create (and, on a failure between the rename and the unlink, strand) a file
// inside the very shared folder the next line refuses — and a watcher on an owned share would
// publish that probe to every peer.
export async function validateDownloadFolderAgainstMounts (folder) {
  const normalized = normalizePath(checkDownloadFolderShape(folder))
  const fold = caseInsensitive(os.platform())
  for (const mount of await listAllMounts()) {
    if (pathsOverlap(normalized, mount.mountPath, path.sep, fold)) {
      throw new AppError(ErrorCodes.DOWNLOAD_FOLDER_OVERLAPS_MOUNT, mount.mountPath)
    }
  }
  if (!writeProbe(normalized)) {
    throw new AppError(ErrorCodes.DOWNLOAD_FOLDER_INVALID, 'Folder is not writable')
  }
  return normalized
}

// Everything about the path itself, with no side effect on disk — so the callers that also
// have rejections to run can order the probe last.
function checkDownloadFolderShape (folder) {
  if (typeof folder !== 'string' || folder.length === 0) {
    throw new AppError(ErrorCodes.DOWNLOAD_FOLDER_INVALID, 'Path is empty')
  }
  if (!path.isAbsolute(folder)) {
    throw new AppError(ErrorCodes.DOWNLOAD_FOLDER_INVALID, 'Path must be absolute')
  }
  let stat
  try {
    stat = fs.statSync(folder)
  } catch {
    throw new AppError(ErrorCodes.DOWNLOAD_FOLDER_INVALID, 'Folder does not exist')
  }
  if (!stat.isDirectory()) {
    throw new AppError(ErrorCodes.DOWNLOAD_FOLDER_INVALID, 'Path is not a directory')
  }
  return folder
}

// The shape+writability rules ALONE, kept in parity with the main-process
// validateDownloadFolder (src/main/main.js) that pre-screens the folder picker. Every worker
// entry point goes through validateDownloadFolderAgainstMounts instead — this is the twin the
// parity tests pin, so main's copy can't drift unnoticed.
export function validateDownloadFolder (folder) {
  checkDownloadFolderShape(folder)
  if (!writeProbe(folder)) {
    throw new AppError(ErrorCodes.DOWNLOAD_FOLDER_INVALID, 'Folder is not writable')
  }
  return folder
}

// Non-blocking warnings shown to the user. These are surfaced as informational
// text — they never gate the flow. Genuinely unsafe locations (cloud-sync folders,
// the downloads dir) are hard-rejected in the validate* functions instead.
function collectAdvisories(absPath) {
  const advisories = []
  const platform = os.platform()

  if (platform === 'darwin') {
    const home = os.homedir()
    const tccPaths = [
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs'),
    ]
    for (const p of tccPaths) {
      if (absPath === p || absPath.startsWith(p + path.sep)) {
        advisories.push({
          code: 'TCC_GATED',
          message: 'macOS will prompt for permission the first time Mirall reads this folder.',
        })
        break
      }
    }
  }

  if (platform === 'win32' && /^[a-z]:\\/i.test(absPath)) {
    const drive = absPath.slice(0, 2).toUpperCase()
    if (drive !== 'C:') {
      advisories.push({
        code: 'REMOVABLE_OR_NETWORK',
        message: 'This drive may be removable or a network share. Watch events may be delayed or missed when disconnected.',
      })
    }
  }

  return advisories
}

export function validateMountPath(absPath, role, ctx = {}) {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'No path provided')
  }
  const normalized = normalizePath(absPath)
  const platform = os.platform()

  const sysRoot = systemRootViolation(normalized, platform, path.sep)
  if (sysRoot) throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_SYSTEM, sysRoot)

  const appData = getStoragePath()
  if (appData && (normalized === appData || normalized.startsWith(appData + path.sep))) {
    throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_APP_DATA, appData)
  }

  const personalRoot = personalRootViolation(normalized, os.homedir(), path.sep, caseInsensitive(platform))
  if (personalRoot) throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_PERSONAL_ROOT, personalRoot)

  if (cloudSyncHint(normalized.toLowerCase())) {
    throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_CLOUD_SYNC, normalized)
  }

  checkWindowsSegments(normalized, platform)

  return validateOverlapAndWrite(normalized, role, ctx)
}

async function validateOverlapAndWrite(normalized, role, ctx) {
  const existing = await listAllMounts()
  for (const m of existing) {
    if (m.role === role && m.shareId === ctx.shareId) continue
    if (overlaps(normalized, m.mountPath) &&
        !overlapAllowed(normalized, role, m.mountPath, m.role)) {
      throw new AppError(ErrorCodes.MOUNT_OVERLAPS, m.mountPath)
    }
  }

  rejectIfOverlapsAnyDownloadRoot(normalized, role)

  if (!writeProbe(normalized)) {
    throw new AppError(ErrorCodes.MOUNT_NOT_WRITABLE, normalized)
  }

  return { mountPath: normalized, advisories: collectAdvisories(normalized) }
}

export function validateMountPathSync(absPath, role, existingMounts, ctx = {}) {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'No path provided')
  }
  const normalized = normalizePath(absPath)
  const platform = os.platform()

  const sysRoot = systemRootViolation(normalized, platform, path.sep)
  if (sysRoot) throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_SYSTEM, sysRoot)

  const appData = getStoragePath()
  if (appData && (normalized === appData || normalized.startsWith(appData + path.sep))) {
    throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_APP_DATA, appData)
  }

  const personalRoot = personalRootViolation(normalized, os.homedir(), path.sep, caseInsensitive(platform))
  if (personalRoot) throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_PERSONAL_ROOT, personalRoot)

  if (cloudSyncHint(normalized.toLowerCase())) {
    throw new AppError(ErrorCodes.MOUNT_FORBIDDEN_CLOUD_SYNC, normalized)
  }

  checkWindowsSegments(normalized, platform)

  for (const m of existingMounts) {
    if (m.role === role && m.shareId === ctx.shareId) continue
    if (overlaps(normalized, m.mountPath) &&
        !overlapAllowed(normalized, role, m.mountPath, m.role)) {
      throw new AppError(ErrorCodes.MOUNT_OVERLAPS, m.mountPath)
    }
  }

  rejectIfOverlapsAnyDownloadRoot(normalized, role)

  if (!writeProbe(normalized)) {
    throw new AppError(ErrorCodes.MOUNT_NOT_WRITABLE, normalized)
  }

  return { mountPath: normalized, advisories: collectAdvisories(normalized) }
}
