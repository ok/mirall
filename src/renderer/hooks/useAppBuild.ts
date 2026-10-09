import { useState } from 'react'
import { releaseChannel, type ReleaseChannel } from '../model/about-view.js'

interface AppBuild {
  version: string
  // The baked package.json version names the running build on every channel; the OTA drive head
  // (`appVersion()`) is what is published, not what is installed.
  label: string
  channel: ReleaseChannel
}

export function useAppBuild(): AppBuild {
  const [build] = useState<AppBuild>(() => {
    const version = window.bridge.pkg().version || '0.0.0'
    const isDev = window.bridge.isDev()
    return { version, label: isDev ? `v${version} (dev)` : `v${version}`, channel: releaseChannel(version, isDev) }
  })
  return build
}
