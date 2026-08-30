export type Scope =
  | { kind: 'files'; spaceId: string }
  | { kind: 'shares'; spaceId: string }
  | { kind: 'share-files'; spaceId: string; shareId?: string }
  | { kind: 'members'; spaceId: string }
  | { kind: 'mirrors'; spaceId: string; shareId?: string }
  | { kind: 'join-requests'; spaceId: string }
  | { kind: 'audit' }

export declare const Scope: {
  files (spaceId: string): Scope
  shares (spaceId: string): Scope
  shareFiles (spaceId: string, shareId?: string): Scope
  members (spaceId: string): Scope
  mirrors (spaceId: string, shareId?: string): Scope
  joinRequests (spaceId: string): Scope
  audit (): Scope
}

// Both sides are loose on purpose, and the implementation is what says so: ids are compared only
// when BOTH the hint and the view pin one. A hint arrives off the wire, and a VIEW may deliberately
// omit an id to mean "every view of this kind" — useSpaces watches { kind: 'members' } across all
// spaces. Typing either as the full Scope union would reject a usage the function is built for.
export interface ScopePattern { kind: string; spaceId?: string; shareId?: string }
export declare function scopeMatches (hint: ScopePattern | null | undefined, view: ScopePattern): boolean
