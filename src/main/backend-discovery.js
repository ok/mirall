'use strict'

// Finding a back end that already serves this profile, and opening its identity. A running back end
// leaves a run record beside its lock (src/shared/contract/run-record.js). The record is advisory: main
// uses the socket it names only once that socket is shown to be this user's and the back end behind
// it has answered a hello with its version. Anything short of that is no back end at all, and the
// caller starts its own as it would without a record.

const fs = require('node:fs')
const path = require('node:path')
const { assertPrivateSocketDir } = require('./window-connections.js')
const { requestOverSocket, greetOverSocket } = require('./worker-request.js')
const { pipeOwnedBySelf } = require('./pipe-owner.js')
const { RUN_RECORD_FILE, parseRunRecord } = require('../shared/contract/run-record.js')
const { isIdentityLock } = require('../shared/contract/errors.js')

// A live listener on this machine accepts at once and answers a hello before it serves anything
// else, a key wait and a boot included. A record whose socket does neither within these is stale.
const PROBE_CONNECT_MS = 1000
const PROBE_ANSWER_MS = 3000

const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\'

const NONE = Object.freeze({ verdict: 'none' })

/** @param {string} storage */
function runRecordFile(storage) {
  return path.join(path.dirname(storage), 'run', RUN_RECORD_FILE)
}

// Read synchronously: on a normal start there is no record, and the spawn that follows stays in the
// same turn as the request that asked for it.
/** @param {string} storage @returns {{ file: string, record: { socket: string, pid: number, version: string } } | null} */
function readRunRecord(storage) {
  const file = runRecordFile(storage)
  try {
    const record = parseRunRecord(fs.readFileSync(file, 'utf8'))
    return record ? { file, record } : null
  } catch {
    return null
  }
}

// Whoever can write the record's folder or the socket's chooses what main talks to. On POSIX both
// folders must be this user's alone and the socket this user's own. On Windows the pipe's owner must
// be this user, as `pipeOwned` reads it; an owner it cannot read is not this user.
async function ownerVerified(file, socketPath, { platform, pipeOwned }) {
  try {
    if (platform === 'win32') return socketPath.startsWith(WINDOWS_PIPE_PREFIX) && (await pipeOwned(socketPath)) === true
    if (!path.isAbsolute(socketPath)) return false
    assertPrivateSocketDir(file, platform)
    assertPrivateSocketDir(socketPath, platform)
    const st = fs.lstatSync(socketPath)
    return st.isSocket() && st.uid === process.getuid()
  } catch {
    return false
  }
}

/**
 * What serves the profile a run record was read for: nothing main may use ('none'), a back end of
 * this user's at exactly `version` ('attach'), or one at another version ('other-version'), which
 * main neither uses nor replaces.
 * @param {{ file: string, record: { socket: string } }} found
 * @param {{ version: string, platform?: string, pipeOwned?: (pipeName: string) => Promise<boolean>, greet?: typeof greetOverSocket }} opts
 * @returns {Promise<{ verdict: 'none' } | { verdict: 'attach', socket: string } | { verdict: 'other-version', version: string | null }>}
 */
async function probeRunRecord({ file, record }, { version, platform = process.platform, pipeOwned = pipeOwnedBySelf, greet = greetOverSocket }) {
  if (!(await ownerVerified(file, record.socket, { platform, pipeOwned }))) return NONE
  let ack
  try {
    ack = await greet(record.socket, { connectTimeoutMs: PROBE_CONNECT_MS, answerTimeoutMs: PROBE_ANSWER_MS })
  } catch {
    return NONE
  }
  const theirs = typeof ack?.appVersion === 'string' ? ack.appVersion : null
  if (theirs !== version) return { verdict: 'other-version', version: theirs }
  return { verdict: 'attach', socket: record.socket }
}

/** The record at `storage` read and probed: probeRunRecord's verdict, or 'none' without a record. */
async function discoverBackend(storage, opts) {
  const found = readRunRecord(storage)
  return found ? probeRunRecord(found, opts) : NONE
}

// Hands the back end its key. True once the identity opened; false when the back end took the key
// and locked on it (a lock code), which leaves it serving the locked screen's recoveries. Anything
// else is an error: the back end did not take the key. The reply waits for the whole boot, so it
// has no deadline here.
async function handKey(socketPath, { kek, relaySeed }, { request = requestOverSocket } = {}) {
  if (!kek) throw new Error('no identity key to hand the worker')
  try {
    await request(socketPath, 'identity:unlock', { kek, ...(relaySeed ? { relaySeed } : {}) })
    return true
  } catch (err) {
    if (isIdentityLock(err.code)) return false
    throw err
  }
}

// A back end main did not start may already have its identity open, and then it is sent nothing.
// One that waits for its key, or is locked by a key that could not open it, is handed this app's
// key, as a spawned one is. The answer is handKey's.
async function openIdentity(socketPath, key, { request = requestOverSocket } = {}) {
  const status = await request(socketPath, 'identity:status')
  if (!status?.locked) return true
  return handKey(socketPath, key, { request })
}

module.exports = { readRunRecord, probeRunRecord, discoverBackend, openIdentity, handKey }
