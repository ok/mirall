// The device facts an organization's configuration uses: its backup folder template resolves against
// the user and computer names, and the instance report carries the computer name and the OS release.
// Never logged; the user name never leaves the device.
import os from 'bare-os'
import { parseTemplate, resolveTemplate } from '../../shared/managed/path-template.js'
import { backupFolderKey } from '../../shared/contract/managed-settings.js'

const PLATFORM = { win32: 'windows', darwin: 'macos', linux: 'linux' }
const safe = (read) => {
  try {
    return String(read() ?? '')
  } catch {
    return ''
  }
}

export const devicePlatform = () => PLATFORM[os.platform()] ?? null
export const computerName = () => safe(() => os.hostname())
export const osRelease = () => safe(() => os.release())

// This platform's locked template resolved for this device: { folder, base, create }, or null when
// the organization sets none or it does not resolve here.
export function resolveBackupFolder(settings, installId) {
  const platform = devicePlatform()
  const template = platform ? settings[backupFolderKey(platform)] : undefined
  if (typeof template !== 'string' || typeof installId !== 'string') return null
  const parsed = parseTemplate(platform, template)
  if (typeof parsed !== 'object') return null
  const resolved = resolveTemplate(parsed, { username: safe(() => os.userInfo().username), hostname: computerName(), installId })
  return typeof resolved === 'object' ? { folder: resolved.path, base: resolved.base, create: resolved.create } : null
}
