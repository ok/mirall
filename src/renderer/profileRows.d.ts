import type { AuditConfig, AuditStats, ConnectivityState } from './types.js'

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string

export function connectionDesc(t: TranslateFn, state: ConnectivityState, peerCount: number | null | undefined): string
export function activityDesc(t: TranslateFn, config: AuditConfig | null, stats: AuditStats | null): string
