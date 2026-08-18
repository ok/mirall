import type { AuditEntry } from './types.js'

export interface ActorLabel {
  key: string | null
  name: string | null
}

export interface RowBadge {
  labelKey: string
  tone: 'error' | 'passive'
}

export interface SentenceValues {
  [key: string]: string
  actor: string
  space: string
  target: string
}

export interface DayGroup {
  key: string
  entries: AuditEntry[]
}

export function actorLabel(entry: AuditEntry): ActorLabel
export function avatarKind(entry: AuditEntry): 'self' | 'peer' | 'system'
export function actorInitials(entry: AuditEntry): string | null
export function rowBadge(entry: AuditEntry): RowBadge | null
export function isSystemRow(entry: AuditEntry): boolean
export function denialReasonKey(entry: AuditEntry): string | null
export function sentenceKey(entry: AuditEntry): string
export function sentenceValues(entry: AuditEntry): SentenceValues

export type SentenceSegment = { text: string; field?: undefined; value?: undefined } | { field: string; value: string; text?: undefined }

export const FIELD_SENTINEL: string
export const SENTENCE_FIELDS: string[]
export function sentinelValues(): SentenceValues
export function splitSentence(rendered: string, values: SentenceValues): SentenceSegment[]
export function formatBytes(bytes: number): string | null
export function formatCount(n: number): string | null
export function metaParts(entry: AuditEntry): string[]
export function dayKey(ts: number, now?: number): string
export function groupByDay(entries: AuditEntry[], now?: number): DayGroup[]
