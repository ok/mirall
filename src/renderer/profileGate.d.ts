import type { Profile } from './types.js'

export interface ProfileGateInput {
  data: Profile | null | undefined
  error: Error | null
  profileNeeded?: boolean
}

export interface ProfileGate {
  profile: Profile | null
  needsSetup: boolean
  loading: boolean
}

export function profileSettled(input: { data: unknown; error: Error | null }): boolean
export function projectProfile(input: ProfileGateInput): ProfileGate
