// The renderer's offline signal.
//
// Chromium's net.online is asymmetric: false is a strong indicator the user cannot reach remote
// sites, true is inconclusive. So it is only ever used to declare offline, never to declare
// healthy — the worker's own connectivity verdict decides everything else.

const { ipcMain, net } = require('electron')
const { sendToAll } = require('./logging.js')

const NET_ONLINE_POLL_MS = 2000
let lastNetOnline = null

function startNetOnlineWatch() {
  const tick = () => {
    let online = true
    try { online = net.online !== false } catch {}
    if (online === lastNetOnline) return
    lastNetOnline = online
    sendToAll('net:online', online)
  }
  tick()
  const timer = setInterval(tick, NET_ONLINE_POLL_MS)
  timer.unref?.()
}

function registerNetOnline() {
  ipcMain.handle('net:online', () => {
    try { return net.online !== false } catch { return true }
  })
}

module.exports = { registerNetOnline, startNetOnlineWatch }
