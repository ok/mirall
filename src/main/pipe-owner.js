'use strict'

// Whether a Windows named pipe is owned by the user this process runs as: the client-side half of
// the owner check main makes before it uses a back end it did not start. An owner check refuses what
// it cannot verify, and this body reads no owner, so it refuses every pipe: on Windows main only
// ever uses the back end it spawned. The Windows owner check replaces this body, keeping the
// signature backend-discovery.js calls: it reads the owner of `pipeName` and answers true only for
// this user, never for another user or the Administrators group.

// Whether pipeOwnedBySelf can say yes to any pipe. Main does not look for a back end it could never
// use; the Windows owner check sets this with the body it replaces.
const PIPE_OWNER_READABLE = false

/** @param {string} pipeName @returns {Promise<boolean>} */
async function pipeOwnedBySelf(pipeName) {
  return false
}

module.exports = { pipeOwnedBySelf, PIPE_OWNER_READABLE }
