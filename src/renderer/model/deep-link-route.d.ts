import type { DeepLinkPayload } from '../platform/global.js'
import type { Space } from '../types/types.js'

export const EXPIRY_GRACE_MS: number

export type DeepLinkRoute =
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'member'; space: Space }
  | { kind: 'join'; code: string; name?: string }

export function routeDeepLink(link: DeepLinkPayload, spaces: Space[], now: number): DeepLinkRoute
