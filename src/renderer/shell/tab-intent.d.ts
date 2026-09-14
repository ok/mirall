export function makeTabIntentTracker(): {
  noteKeyDown(key: string, at: number): void
  isTabIntent(at: number): boolean
}
