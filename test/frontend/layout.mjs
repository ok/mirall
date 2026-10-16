import { execFileSync } from 'node:child_process'

let cached = null

function screen() {
  if (cached) return cached
  try {
    const out = execFileSync(
      'osascript',
      ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var f=$.NSScreen.mainScreen.visibleFrame; Math.round(f.size.width)+"x"+Math.round(f.size.height)'],
      { encoding: 'utf8', timeout: 5000 },
    )
    const [w, h] = out.trim().split('x').map(Number)
    cached = { w: w || 1920, h: h || 1080 }
  } catch {
    cached = { w: 1920, h: 1080 }
  }
  return cached
}

// Split the screen into `cols` equal columns and center each instance's window
// within its column, both horizontally and vertically. Windows stay fully
// on-screen (off-screen windows yield an empty AX tree in Chromium).
// The four numbers are the app's own layout thresholds, not display maths: 1072 is the narrowest
// column that holds the narrowest window (MIN_WINDOW_WIDTH) with its gaps, 1024/1200 bound the
// window so it is never asked below the minimum main enforces nor stretched past the point the
// tiles stop fitting, and 1040 keeps the whole window on a laptop screen. A scenario failing to find an element on a small display is
// usually one of these, not the assertion.
export function tile(slot, total = 2) {
  const { w, h } = screen()
  const gap = 24
  const cols = Math.max(1, Math.min(total, Math.floor(w / 1072)))
  const colW = Math.floor(w / cols)
  const width = Math.max(1024, Math.min(1200, colW - gap * 2))
  const height = Math.min(1040, h - gap * 2)
  if (slot < cols) {
    const col = slot
    return {
      x: Math.round(col * colW + (colW - width) / 2),
      y: Math.round((h - height) / 2),
      width,
      height,
    }
  }
  const over = slot - cols
  return { x: gap + over * 40, y: gap + over * 40, width, height }
}
