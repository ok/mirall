// The relay slot's secret half: the member seed behind a private-relay ticket, kept in the
// safeStorage vault. The public half of the slot is the worker's (network:set-relay), and the
// renderer writes the two in that order: the seed first, so a slot that names a seed can always
// find it, then the slot.
//
// The ticket codec is ESM and main is CJS, so it loads the way deeplink.js loads the invite
// envelope: one dynamic import at module evaluation, awaited by every consumer.

const { ipcMain } = require('electron')
const relaySecret = require('./relay-secret.js')

const relayTicketReady = import('../shared/network/relay-ticket.js')

function registerRelaySlot({ getPear }) {
  // Classify and validate a pasted relay input. No side effects, and no secret in the reply:
  // the renderer needs the relay key a ticket decodes to and an error code, nothing else.
  ipcMain.handle('relay:parse', async (_evt, input) => {
    const { parseRelayInput } = await relayTicketReady
    const res = parseRelayInput(typeof input === 'string' ? input : '')
    return res.ok ? { ok: true, kind: res.kind, publicKey: res.publicKey } : { ok: false, code: res.code }
  })

  // Writes the seed a private ticket carries, or clears it for an open relay or a removal.
  ipcMain.handle('relay:set', async (_evt, payload) => {
    const { parseRelayInput } = await relayTicketReady
    const storagePath = getPear().storage
    if (!payload || typeof payload !== 'object' || payload.relay === undefined) return { ok: false, code: 'invalid-format' }
    if (payload.relay === null) {
      try {
        relaySecret.clearRelaySeed(storagePath)
      } catch (err) {
        console.error('[relay] could not clear the member seed:', err && err.message ? err.message : err)
        return { ok: false, code: 'save-failed' }
      }
      return { ok: true, kind: null, publicKey: null }
    }

    const parsed = parseRelayInput(typeof payload.relay?.input === 'string' ? payload.relay.input : '')
    if (!parsed.ok) return { ok: false, code: parsed.code }
    try {
      if (parsed.kind === 'private') relaySecret.writeRelaySeedHex(storagePath, Buffer.from(parsed.seed).toString('hex'))
      else relaySecret.clearRelaySeed(storagePath)
    } catch (err) {
      console.error('[relay] could not write the member seed:', err && err.message ? err.message : err)
      return { ok: false, code: 'save-failed' }
    }
    return { ok: true, kind: parsed.kind, publicKey: parsed.publicKey }
  })
}

module.exports = { registerRelaySlot }
