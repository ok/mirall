export interface RequestMetricRow {
  calls: number
  failures: number
  inFlight: number
  avgMs: number
  maxMs: number
  slow: number
}

export interface RequestMetrics {
  begin (type: string): (ok: boolean) => number
  snapshot (): Record<string, RequestMetricRow>
  reset (): void
}

export declare function createRequestMetrics (opts?: { now?: () => number; slowMs?: number }): RequestMetrics
