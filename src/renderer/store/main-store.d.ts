import type { MainQueryName, MainQueryValue } from './main-queries.js'
import type { MirallBridge } from '../global.js'

export interface MainSnapshot<T> {
  data: T | undefined
  error: Error | null
  loading: boolean
}

export declare function configureMainStore (bridge: MirallBridge): void
export declare function fetchMain<K extends MainQueryName> (name: K): Promise<MainQueryValue[K]>
export declare function writeMain<K extends MainQueryName> (name: K, value: MainQueryValue[K]): Promise<MainQueryValue[K]>
export declare function setMainData<K extends MainQueryName> (name: K, data: MainQueryValue[K] | undefined): void
export declare function subscribeMain (name: MainQueryName, notify: () => void): () => void
export declare function peekMain<K extends MainQueryName> (name: K): MainSnapshot<MainQueryValue[K]>
export declare function installMainPushBridge (): () => void
export declare function resetMainStore (): void
