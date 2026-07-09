// Tracks window bounds during the session (debounced) and persists the last good size to main on unload for next-launch restore.
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const SAVE_DELAY = 500
const MIN_WIDTH = 900
// Keep in sync with the BrowserWindow minHeight in src/main/main.js.
const MIN_HEIGHT = 870

let timer: ReturnType<typeof setTimeout> | null = null
let lastBounds: Bounds | null = null

export async function restoreWindowBounds(): Promise<void> {
  return
}

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
