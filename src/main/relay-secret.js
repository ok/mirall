const electron = require('electron')
const fs = require('fs')
const path = require('path')

// The member seed behind a private-relay ticket, at rest. It is a bearer credential —
// whoever holds it can present that member identity at that relay — so it does not go in
// config.json, which is plain text, lands in backups, and is the file a user copies when
// they move machines. It lives beside kek.enc under the same Electron safeStorage main.js
// already treats as a hard start-up requirement, so this adds no new way to fail to boot.
const SEED_HEX = /^[0-9a-f]{64}$/

const seedFile = (storagePath) => path.join(path.dirname(storagePath), 'relay-ticket.enc')

function readRelaySeedHex(storagePath, { safeStorage = electron.safeStorage } = {}) {
  const file = seedFile(storagePath)
  try {
    if (!fs.existsSync(file)) return null
    const hex = safeStorage.decryptString(fs.readFileSync(file))
    return SEED_HEX.test(hex) ? hex : null
  } catch (err) {
    // A vault we cannot read silently degrades the relay identity to an ephemeral key, and
    // the relay then stops admitting us with no diagnosable reason. Say so.
    console.warn('[relay] could not read the member seed:', err && err.message ? err.message : err)
    return null
  }
}

function writeRelaySeedHex(storagePath, seedHex, { safeStorage = electron.safeStorage } = {}) {
  if (!SEED_HEX.test(seedHex)) throw new Error('relay seed must be 32 hex-encoded bytes')
  const file = seedFile(storagePath)
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, safeStorage.encryptString(seedHex))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

// Throws rather than swallowing: a seed we failed to delete is a durable member identity the
// config no longer accounts for, and the node would keep presenting it on every later boot with
// nothing on screen to explain why. The caller reports the failure instead of claiming success.
// `force` already makes a missing file a no-op, so anything reaching the catch is real — a
// locked file on Windows, EPERM, a read-only volume.
function clearRelaySeed(storagePath) {
  fs.rmSync(seedFile(storagePath), { force: true })
}

// test seam: seedFile is exported for tests only.
module.exports = { readRelaySeedHex, writeRelaySeedHex, clearRelaySeed, seedFile }
