// Resolves the download destination: the user-configured folder, or the OS default.
import os from 'bare-os'
import path from 'bare-path'
import { getRuntimeConfig } from './runtime-config.js'

export function getDownloadDir() {
  return getRuntimeConfig().downloadFolder || path.join(os.homedir(), 'Downloads')
}
