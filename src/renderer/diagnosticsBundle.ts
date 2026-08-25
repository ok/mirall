import { request } from './ipc.js'
import type { DiagnosticLogEntry } from './types.js'

export interface BundleOptions {
  redact: boolean
  includeLogs: boolean
}

export interface DiagnosticsBundle {
  schema: number
  reference: string | null
  logs: DiagnosticLogEntry[] | null
  [key: string]: unknown
}

// Preview and save call this with the same options, so what the user is shown is what
// gets written.
export async function buildBundle({ redact, includeLogs }: BundleOptions): Promise<DiagnosticsBundle> {
  // timeout 0 — matches audit:export; assembling the bundle walks swarm.peers and can
  // outlast the default request budget.
  const core = await request('diagnostics:export', { redact }, 0) as DiagnosticsBundle
  const logs = includeLogs ? await window.bridge.getDiagnosticLogs({ redact }) : null
  return { ...core, logs }
}

export function serialiseBundle(bundle: DiagnosticsBundle): string {
  return JSON.stringify(bundle, null, 2)
}

export function bundleFilename(bundle: DiagnosticsBundle): string {
  const stamp = new Date().toISOString().slice(0, 10)
  const ref = bundle.reference ? `-${bundle.reference}` : ''
  return `mirall-diagnostics-${stamp}${ref}.json`
}

const PREVIEW_MAX_CHARS = 64 * 1024

export function previewText(serialised: string, marker: string): string {
  if (serialised.length <= PREVIEW_MAX_CHARS) return serialised
  return serialised.slice(0, PREVIEW_MAX_CHARS) + `\n… ${marker}`
}
