// What an organization's backup folder template is resolved against on this device. Read once per
// resolution and never logged or reported.
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

// This platform's locked template resolved for this device: { folder, base, create }, or null when
// the organization sets none or it does not resolve here.
export function resolveBackupFolder(settings, installId) {
  const platform = devicePlatform()
  const template = platform ? settings[backupFolderKey(platform)] : undefined
  if (typeof template !== 'string' || typeof installId !== 'string') return null
  const parsed = parseTemplate(platform, template)
  if (typeof parsed !== 'object') return null
  const resolved = resolveTemplate(parsed, { username: safe(() => os.userInfo().username), hostname: safe(() => os.hostname()), installId })
  return typeof resolved === 'object' ? { folder: resolved.path, base: resolved.base, create: resolved.create } : null
}
