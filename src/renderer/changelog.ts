// Parses CHANGELOG.md (## vX headings) and picks the entries to surface after an update via the persisted last-seen version.
import { getLastSeenVersion, setLastSeenVersion } from './config-client.js'

export interface ChangelogEntry {
  version: string
  body: string
}

const HEADING_RE = /^## v(\S+)\s*$/

export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: ChangelogEntry | null = null
  for (const line of text.split('\n')) {
    const m = line.match(HEADING_RE)
    if (m) {
      if (current) entries.push(current)
      current = { version: m[1], body: '' }
    } else if (current) {
      current.body += line + '\n'
    }
  }
  if (current) entries.push(current)
  return entries
}

function cmp(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

export function entriesBetween(
  entries: ChangelogEntry[],
  fromExclusive: string,
  toInclusive: string,
): ChangelogEntry[] {
  return entries.filter(
    (e) => cmp(e.version, fromExclusive) > 0 && cmp(e.version, toInclusive) <= 0,
  )
}

export async function checkChangelogOnBoot(
  isExistingInstall: boolean,
): Promise<ChangelogEntry[] | null> {
  const current = window.bridge.pkg().version
  const lastSeen = getLastSeenVersion()
  if (!lastSeen) {
    setLastSeenVersion(current)
    if (!isExistingInstall) return null
    const text = await window.bridge.getChangelog()
    if (!text) return null
    const slice = parseChangelog(text).filter((e) => e.version === current)
    return slice.length ? slice : null
  }
  if (lastSeen === current) return null

  const text = await window.bridge.getChangelog()
  if (!text) {
    setLastSeenVersion(current)
    return null
  }
  const slice = entriesBetween(parseChangelog(text), lastSeen, current)
  return slice.length ? slice : null
}

export function dismissChangelog(): void {
  setLastSeenVersion(window.bridge.pkg().version)
}

export async function loadAllEntries(): Promise<ChangelogEntry[]> {
  const text = await window.bridge.getChangelog()
  return text ? parseChangelog(text) : []
}
