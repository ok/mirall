import { MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT } from '../shared/contract/limits.js'
// Tracks window bounds during the session (debounced) and persists the last good size to main on unload; main restores them itself on the next launch.
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const SAVE_DELAY = 500
const MIN_WIDTH = MIN_WINDOW_WIDTH
const MIN_HEIGHT = MIN_WINDOW_HEIGHT

let timer: ReturnType<typeof setTimeout> | null = null
let lastBounds: Bounds | null = null

export function trackWindowBounds(): void {
  fetchAndSave()
  window.addEventListener('resize', () => debouncedFetchAndSave())
  window.addEventListener('blur', () => fetchAndSave())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') fetchAndSave()
  })
  window.addEventListener('beforeunload', () => {
    if (lastBounds) void window.bridge.setWindowBounds(lastBounds)
  })
}

async function fetchAndSave(): Promise<void> {
  const bounds = await window.bridge.getWindowBounds()
  if (!bounds) return
  if (bounds.width < MIN_WIDTH || bounds.height < MIN_HEIGHT) return
  lastBounds = bounds
}

function debouncedFetchAndSave(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => fetchAndSave(), SAVE_DELAY)
}
