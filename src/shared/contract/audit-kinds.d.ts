export declare const CATEGORY: Readonly<Record<string, string>>
export declare const KINDS: Readonly<Record<string, { category: string; tier: string }>>
export declare const CATEGORIES: readonly string[]
export declare function isKnownKind (kind: string): boolean
// These THROW on an unknown kind rather than returning null — the vocabulary is closed and a kind
// absent from it is a programming error, which is the whole point of isKnownKind existing. Declaring
// `| null` invited a caller to null-guard and still crash on the TypeError.
export declare function categoryOf (kind: string): string
export declare function tierOf (kind: string): string
