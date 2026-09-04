import type { AppPrefs } from '../global.js'

export declare function peekPrefs (): AppPrefs | null
export declare function subscribePrefs (notify: () => void): () => void
export declare function loadPrefs (): Promise<AppPrefs>
export declare function writePrefs (patch: Partial<AppPrefs>): Promise<AppPrefs>
export declare function resetPrefsStore (): void
