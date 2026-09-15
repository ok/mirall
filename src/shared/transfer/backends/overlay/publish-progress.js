// The one publishing-progress reporter both publish sides use. Our own row is 'publishing' (we are
// adding this file); the peers we broadcast to see 'preparing' (they are waiting on our hash). Same
// ticker, one phase per side. The terminal frames go out only for a bar this reporter raised: a
// peer's decoration map is cleared only by `done`, and a fast-pathed unchanged file never raised
// one. Imports nothing that only loads under Bare.
import { makeProgressTicker } from '../../progress-ticker.js'

let emit = null
let broadcast = null

export function initPublishProgress(d) { emit = d.emit; broadcast = d.broadcast }
export function resetPublishProgress() { emit = null; broadcast = null }

export function makePublishProgress({ spaceId, shareId, relPath, decoKey }) {
  let ticker = null
  const deco = (patch) => emit?.('event:decoration', { channel: 'transfer', spaceId, key: decoKey, ...patch })
  return {
    onAdvertised(size) {
      ticker = makeProgressTicker(size, ({ bytes, total, speed, eta }) => {
        deco({ phase: 'publishing', bytes, total, speed, eta })
        broadcast?.(spaceId, { shareId, relPath, bytes, total, eta })
      })
    },
    onProgress(len) { ticker?.push(len) },
    done() {
      if (!ticker) return
      deco({ done: true })
      broadcast?.(spaceId, { shareId, relPath, done: true })
    },
  }
}
