import type { AppPrefs } from '../global.js'

export declare function configurePrefsStore (bridge: {
  getPrefs: () => Promise<AppPrefs>
  setPrefs: (patch: Partial<AppPrefs>) => Promise<AppPrefs>
}): void
export declare function peekPrefs (): AppPrefs | null
export declare function subscribePrefs (notify: () => void): () => void
export declare function loadPrefs (): Promise<AppPrefs>
export declare function writePrefs (patch: Partial<AppPrefs>): Promise<void>
export declare function resetPrefsStore (): void
