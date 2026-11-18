'use strict'

// Finding a back end that already serves this profile, and opening its identity. A running back end
// leaves a run record beside its lock (src/shared/contract/run-record.js). The record is advisory:
// main uses the socket it names only once that socket is shown to be this user's and the back end
// behind it has answered a hello naming this profile's data folder and its version. Anything short of
// that is no back end at all, and the caller starts its own as it would without a record.

const fs = require('node:fs')
const path = require('node:path')
const { assertPrivateSocketDir } = require('./window-connections.js')
const { requestOverSocket, greetOverSocket } = require('./worker-request.js')
const { pipeOwnedBySelf, PIPE_OWNER_READABLE } = require('./pipe-owner.js')
const { RUN_RECORD_FILE, parseRunRecord } = require('../shared/contract/run-record.js')
const { CODES, isIdentityLock } = require('../shared/contract/errors.js')

// A live listener on this machine accepts at once; a socket that refuses or is gone is stale, and
// that is known within the connect bound. One that accepted answers a hello before it serves anything
// else, but a boot can hold its loop for a long while (ipc-liveness.js), so the answer has a bound
// that covers a boot: past it the holder is live and unusable, which is no reason to start a second.
const PROBE_CONNECT_MS = 1000
const BUSY_ANSWER_MS = 60000

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

// Whether this build can ever use a back end it did not start on `platform`: not where it cannot
// verify who owns the socket.
function canAttach(platform = process.platform) {
  return platform !== 'win32' || PIPE_OWNER_READABLE
}

// The data folder the record sits in, as the back end states its own: both resolved, so a symlinked
// or relative spelling of one folder is the same folder. A folder that cannot be resolved is none.
function realDataDir(file) {
  try {
    return fs.realpathSync.native(path.dirname(path.dirname(file)))
  } catch {
    return null
  }
}

/**
 * What serves the profile a run record was read for: nothing main may use ('none'), a back end of
 * this user's for this data folder at exactly `version` on this build's `channel` ('attach'), one at
 * another version or on another channel ('other-version'), or one that accepted and has not answered within a boot's bound ('busy'). Main
 * neither uses nor replaces the last two.
 * @param {{ file: string, record: { socket: string } }} found
 * @param {{ version: string, channel?: string, platform?: string, pipeOwned?: (pipeName: string) => Promise<boolean>, greet?: typeof greetOverSocket, busyAnswerMs?: number, dataDirOf?: (file: string) => string | null }} opts
 * @returns {Promise<{ verdict: 'none' } | { verdict: 'attach', socket: string } | { verdict: 'other-version', version: string | null } | { verdict: 'busy' }>}
 */
async function probeRunRecord({ file, record }, { version, channel, platform = process.platform, pipeOwned = pipeOwnedBySelf, greet = greetOverSocket, busyAnswerMs = BUSY_ANSWER_MS, dataDirOf = realDataDir }) {
  if (!(await ownerVerified(file, record.socket, { platform, pipeOwned }))) return NONE
  let ack
  try {
    ack = await greet(record.socket, { connectTimeoutMs: PROBE_CONNECT_MS, answerTimeoutMs: busyAnswerMs })
  } catch (err) {
    return err?.unanswered ? { verdict: 'busy' } : NONE
  }
  // A record copied or moved with its folder names another profile's socket: that back end serves
  // another store, and is never handed this profile's key.
  const ours = dataDirOf(file)
  if (!ours || ack?.dataDir !== ours) return NONE
  const theirs = typeof ack?.appVersion === 'string' ? ack.appVersion : null
  // The same text on another channel is another build: a back end started from a source checkout
  // runs as a development build, with the test levers and signing key an installed app refuses.
  if (theirs !== version || ack?.channel !== channel) return { verdict: 'other-version', version: theirs }
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
// key, as a spawned one is. The answer is handKey's. Another client may have handed a key between
// the status and the unlock: the unlock is then refused as not waiting, and the identity that boot
// opened is the answer. `stop()` is asked before the key goes out.
async function openIdentity(socketPath, key, { request = requestOverSocket, stop = () => false } = {}) {
  const status = await request(socketPath, 'identity:status')
  if (!status?.locked) return true
  if (stop()) throw new Error('the app is quitting')
  try {
    return await handKey(socketPath, key, { request })
  } catch (err) {
    if (err?.code !== CODES.NOT_AUTHORIZED) throw err
    const now = await request(socketPath, 'identity:status')
    if (now && !now.locked) return true
    throw err
  }
}

module.exports = { readRunRecord, probeRunRecord, discoverBackend, openIdentity, handKey, canAttach }
