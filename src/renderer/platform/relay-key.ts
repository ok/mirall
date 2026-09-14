export function truncateRelayKey(key: string): string {
  return key.length <= 16 ? key : `${key.slice(0, 8)}…${key.slice(-6)}`
}
