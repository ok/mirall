'use strict'

// Whether a Windows named pipe is owned by the user this process runs as: the client-side half of
// the owner check main makes before it uses a back end it did not start. An owner check refuses what
// it cannot verify, and this build cannot read a pipe's owner, so every pipe is refused and on
// Windows main only ever uses the back end it spawned itself.

/** @param {string} pipeName @returns {Promise<boolean>} */
async function pipeOwnedBySelf(pipeName) {
  return false
}

module.exports = { pipeOwnedBySelf }
