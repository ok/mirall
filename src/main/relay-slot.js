// The relay slot: one relay this node offers, pasted as a key or a ticket.
//
// The ticket codec is ESM and main is CJS, so it loads the way deeplink.js loads the invite
// envelope: one dynamic import at module evaluation, awaited by every consumer.

const { ipcMain } = require('electron')
const relaySecret = require('./relay-secret.js')

const relayTicketReady = import('../shared/network/relay-ticket.js')

function registerRelaySlot({ config, getPear }) {
  // Classify and validate a pasted relay input. No side effects, and no secret in the reply:
  // the renderer needs the relay key a ticket decodes to and an error code, nothing else.
  ipcMain.handle('relay:parse', async (_evt, input) => {
    const { parseRelayInput } = await relayTicketReady
    const res = parseRelayInput(typeof input === 'string' ? input : '')
    return res.ok ? { ok: true, kind: res.kind, publicKey: res.publicKey } : { ok: false, code: res.code }
  })

  // The single writer for the relay slot: config.json takes the public half, the safeStorage
  // vault takes the member seed. `identityChanged` tells the renderer whether the DHT node has
  // to be rebuilt — defaultKeyPair is fixed at construction, so a pinned identity coming or
  // going cannot be applied live.
  ipcMain.handle('relay:set', async (_evt, payload) => {
    const { parseRelayInput } = await relayTicketReady
    const store = config()
    const storagePath = getPear().storage
    const before = store.get('network.relay')
    // A frame with no mode would normalize to 'off' and silently turn the relay off, so an
    // empty payload reports the current state instead of writing one.
    if (!payload) return { ok: true, network: store.rendererSnapshot().network, identityChanged: false }
    const mode = payload.mode

    // relay omitted → a mode change, or a probe verdict, against the slot already stored. The
    // vault is untouched, so this path needs no input to re-parse.
    if (payload.relay === undefined) {
      const next = before && payload.lastTest !== undefined ? { ...before, lastTest: payload.lastTest } : before
      return { ok: true, network: store.setRelay(mode, next), identityChanged: false }
    }

    // Vault first, then config, then flush. The two writes cannot be made atomic, so the order
    // picks which half survives a crash between them: a seed the config does not account for is a
    // pinned identity the app presents forever with nothing on screen to explain it, while a config
    // naming a seed that is not there degrades visibly (the worker refuses to install the relay and
    // the probe reports it unreachable). Always leave the visible one.
    if (payload.relay === null) {
      try {
        relaySecret.clearRelaySeed(storagePath)
      } catch (err) {
        console.error('[relay] could not clear the member seed:', err && err.message ? err.message : err)
        return { ok: false, code: 'save-failed' }
      }
      const network = store.setRelay(mode, null)
      store.flush()
      return { ok: true, network, identityChanged: before?.kind === 'private' }
    }

    const parsed = parseRelayInput(payload.relay.input)
    if (!parsed.ok) return { ok: false, code: parsed.code }

    try {
      if (parsed.kind === 'private') relaySecret.writeRelaySeedHex(storagePath, Buffer.from(parsed.seed).toString('hex'))
      else relaySecret.clearRelaySeed(storagePath)
    } catch (err) {
      console.error('[relay] could not write the member seed:', err && err.message ? err.message : err)
      return { ok: false, code: 'save-failed' }
    }

    const network = store.setRelay(mode, {
      publicKey: parsed.publicKey,
      kind: parsed.kind,
      label: typeof payload.relay.label === 'string' ? payload.relay.label : '',
      enabled: true,
      lastTest: null,
    })
    // Debounced by default (250ms) and otherwise only flushed on before-quit, which a SIGKILL or a
    // power loss never reaches — so the slot that names the seed is written now, not eventually.
    store.flush()
    // Only a pinned identity coming or going forces a rebuild. Adding, replacing or removing an
    // OPEN relay derives no identity, so it applies live over network:set-relay.
    return { ok: true, network, identityChanged: before?.kind === 'private' || parsed.kind === 'private' }
  })
}

module.exports = { registerRelaySlot }
