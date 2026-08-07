import type { RendererConfig, RendererConfigPatch } from './config-client.js'

export interface PkgInfo {
  name: string
  productName: string
  version: string
  upgrade?: string
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

// Content-plane transfer caps in KB/s; 0 = unlimited.
export interface BandwidthLimits {
  downloadKBps: number
  uploadKBps: number
}

export type PearEventName = 'updating' | 'updated'

export type NotificationUrgency = 'normal' | 'critical' | 'low'

export type NotificationClickPayload =
  | { kind: 'member-joined' | 'member-left' }
  | {
      kind: 'transfer-complete' | 'transfer-error' | 'transfer-paused'
      spaceId: string
      localPath?: string
      path?: string
    }

export interface NotificationSpec {
  id?: string
  title: string
  body: string
  icon?: string
  silent?: boolean
  urgency?: NotificationUrgency
  groupId?: string
  payload?: NotificationClickPayload
}

export interface NotificationShowResult {
  shown: boolean
  id: string | null
}

export interface NotificationClickEvent {
  id: string | null
  payload: NotificationClickPayload | null
}

export interface AppPrefs {
  minimizeToTray: boolean
  openAtLogin: boolean
  firstHideNoticeShown: boolean
  appMenuAutoHide: boolean
}

export interface TrayLabels {
  show: string
  settings: string
  quit: string
  tooltip: string
}

export interface MenuContext {
  inSpace: boolean
}

export interface FirstHideNoticePayload {
  platform: NodeJS.Platform
}

export interface DeepLinkJoin {
  kind: 'join'
  code: string
  name?: string
}

export type DeepLinkPayload = DeepLinkJoin

export type IdentityProtection = 'protected' | 'weak' | 'disabled'

export interface MirallBridge {
  pkg(): PkgInfo
  isDev(): boolean
  getLocale(): string
  getPlatform(): NodeJS.Platform
  getPathForFile(file: File): string

  applyUpdate(): Promise<void>
  checkForUpdate(): Promise<{ triggered: boolean; length?: number; fork?: number; reason?: string; error?: string }>
  appVersion(): Promise<{ length: number; fork: number; semver: string | null }>
  getChangelog(): Promise<string>
  getIdentityProtection(): Promise<IdentityProtection>
  setVerbose(on?: boolean): Promise<boolean>
  onMainLog(listener: (entry: { level: 'log' | 'warn' | 'error'; text: string }) => void): () => void
  onPearEvent(name: PearEventName, listener: () => void): () => void

  startWorker(specifier: string): Promise<boolean>
  onWorkerIPC(specifier: string, listener: (data: Uint8Array) => void): () => void
  onWorkerStdout(specifier: string, listener: (data: Uint8Array) => void): () => void
  onWorkerStderr(specifier: string, listener: (data: Uint8Array) => void): () => void
  onWorkerExit(specifier: string, listener: (code: number) => void): () => void
  writeWorkerIPC(specifier: string, data: Uint8Array | string): Promise<boolean>

  getWindowBounds(): Promise<WindowBounds | null>
  setWindowBounds(bounds: WindowBounds): Promise<void>

  getZoom(): Promise<number>
  setZoom(factor: number): Promise<number>
  onZoomChanged(listener: (factor: number) => void): () => void

  setTheme(mode: 'light' | 'dark' | 'system'): Promise<boolean>

  getDownloadFolder(): Promise<string>
  setDownloadFolder(folder: string): Promise<string>
  browseDownloadFolder(): Promise<string | null>
  getBandwidth(): Promise<BandwidthLimits>
  setBandwidth(patch: BandwidthLimits): Promise<BandwidthLimits>
  browseShareFolder(): Promise<string | null>
  startOwnedFolderWatcher(shareId: string, mountPath: string, ignore: string[]): Promise<{ ok: boolean; reason?: string }>
  stopOwnedFolderWatcher(shareId: string): Promise<{ ok: boolean }>

  notify(spec: NotificationSpec): Promise<NotificationShowResult>
  notifyIsSupported(): Promise<boolean>
  isWindowFocused(): Promise<boolean>
  focusWindow(): Promise<void>
  showInFolder(fullPath: string): Promise<{ ok: boolean }>
  onNotificationClick(listener: (event: NotificationClickEvent) => void): () => void

  getPrefs(): Promise<AppPrefs>
  setPrefs(partial: Partial<AppPrefs>): Promise<AppPrefs>
  getConfig(): RendererConfig
  setConfig(patch: RendererConfigPatch): Promise<RendererConfig>
  setTrayLabels(labels: TrayLabels): Promise<void>
  menuContextChanged(ctx: MenuContext): Promise<void>
  onFirstHideNotice(listener: (payload: FirstHideNoticePayload) => void): () => void
  onHiddenToTray(listener: () => void): () => void
  onKeyboardCommand(listener: (id: string) => void): () => void

  deepLink: {
    subscribe(listener: (link: DeepLinkPayload) => void): () => void
  }
}

// Debugging surface exposed on window.mirall (see src/renderer/dev-console.ts).
// Read-only diagnostics resolve to whatever the underlying worker handler
// returns; verbose() toggles live logging across the worker and main.
export interface MirallDevConsole {
  help(): void
  verbose(on?: boolean): Promise<boolean>
  status(): Promise<unknown>
  spaces(): Promise<unknown>
  members(spaceId: string): Promise<unknown>
  storage(): Promise<unknown>
  audit(opts?: Record<string, unknown>): Promise<unknown>
  profile(): Promise<unknown>
  mounts(): Promise<unknown>
  features(): Promise<unknown>
  version(): Promise<unknown>
  update(): Promise<unknown>
  identity(): Promise<unknown>
}

declare global {
  // Compile-time flag injected by esbuild (--define:__DEV__). In production
  // builds it is the literal `false`, so the dev-only axe-core bootstrap in
  // main.tsx is dead-code-eliminated and never pulled into the bundle.
  const __DEV__: boolean

  interface Window {
    bridge: MirallBridge
    mirall: MirallDevConsole
  }

  namespace React {
    interface CSSProperties {
      WebkitAppRegion?: string
    }
  }
}
