export type DecodedInvite =
  | { v: 0; topic: string }
  | {
      v: 1
      topic: string
      name?: string
      owner?: string
      ownerName?: string
      creator?: string
      schemaVersion?: number
      autoAdmit?: boolean
      inviteId?: string
      expiresAt?: number
    }

export interface InviteFields {
  topic: string
  name?: string
  owner?: string
  ownerName?: string
  creator?: string
  schemaVersion?: number
  autoAdmit?: boolean
  inviteId?: string
  expiresAt?: number
}

export declare function extractInviteCode(input: string): string
export declare function decodeInvite(input: string): DecodedInvite | null
export declare function encodeInvite(fields: InviteFields): string
export declare const HEX64: RegExp
export declare const NAME_MAX: number
