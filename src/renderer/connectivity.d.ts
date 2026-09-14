import type { NetworkStatusScreen, ReachabilityCause } from './types.js'

export type FixStep = 'vpn' | 'mobile' | 'otherNetwork' | 'turnOnNetwork'
export type ReachableState = 'unknown' | 'noAddress' | 'changingPorts' | 'yes'

export function fixStepsFor(cause: ReachabilityCause | null): FixStep[]
export function reachableState(status: NetworkStatusScreen): ReachableState
export function formatDuration(ms: number): string
