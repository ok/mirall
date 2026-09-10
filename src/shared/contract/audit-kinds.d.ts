export declare const CATEGORY: Readonly<Record<string, string>>
export declare const KINDS: Readonly<Record<string, { category: string; tier: string }>>
export declare const CATEGORIES: readonly string[]
export declare function isKnownKind (kind: string): boolean
// Throws on an unknown kind — the vocabulary is closed, so a kind absent from it is a programming
// error; `| null` would invite a guard that still crashes.
export declare function categoryOf (kind: string): string
export declare function tierOf (kind: string): string
