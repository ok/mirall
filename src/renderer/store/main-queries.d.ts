import type { AppPrefs, BandwidthLimits, MirallBridge } from '../global.js'

export type MainQueryName =
  | 'main:prefs'
  | 'main:download-folder'
  | 'main:bandwidth'
  | 'main:zoom'

export interface MainQueryValue {
  'main:prefs': AppPrefs
  'main:download-folder': string
  'main:bandwidth': BandwidthLimits
  'main:zoom': number
}

export interface MainQuerySpec<K extends MainQueryName = MainQueryName> {
  read: (bridge: MirallBridge) => Promise<MainQueryValue[K]>
  write: (bridge: MirallBridge, value: MainQueryValue[K]) => Promise<MainQueryValue[K]>
  push: keyof MirallBridge | null
}

export declare const MAIN_QUERIES: Readonly<Record<MainQueryName, MainQuerySpec>>
export declare const MAIN_QUERY_NAMES: readonly MainQueryName[]
