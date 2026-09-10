// Nothing clamps a restored window to a display that still exists. A monitor unplugged since the
// last quit leaves its coordinates in config.json, and Electron will happily open the window there
// — off every screen, unreachable, and recoverable only by editing config.json by hand. Size needs
// no such guard: createWindow passes minWidth/minHeight, which Electron enforces.

// Enough of the window has to land inside a work area to be grabbed and dragged back. A false
// negative costs the user a re-centred window; a false positive costs them the window.
const MIN_VISIBLE = 80

function overlap (aStart, aSize, bStart, bSize) {
  return Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart)
}

function boundsOnSomeDisplay (bounds, displays) {
  if (!bounds || !Array.isArray(displays)) return false
  for (const display of displays) {
    const area = display && display.workArea
    if (!area) continue
    // Horizontally, any grabbable strip will do — the title bar runs the whole width.
    if (overlap(bounds.x, bounds.width, area.x, area.width) < MIN_VISIBLE) continue
    // Vertically it will not: the title bar is the only draggable part and it is at the TOP, so a
    // window hanging off the top of the work area is unreachable no matter how much of its body
    // shows. Measuring plain overlap on this axis accepts exactly that window.
    if (bounds.y < area.y) continue
    if (area.y + area.height - bounds.y < MIN_VISIBLE) continue
    return true
  }
  return false
}

// Keeps the remembered size, drops a position no display can show. Electron then centres it.
function usableBounds (bounds, displays) {
  if (!bounds) return null
  if (boundsOnSomeDisplay(bounds, displays)) return bounds
  return { width: bounds.width, height: bounds.height }
}

module.exports = { boundsOnSomeDisplay, usableBounds, MIN_VISIBLE }
