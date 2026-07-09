import Sidecar from 'bare-sidecar'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { scaled, summarize, tail, TIMING } from './timing.js'

// A full client = the REAL worker (src/worker/main.js) run as a bare subprocess
// via bare-sidecar, driven over its NDJSON IPC (the same protocol Electron main
// uses). The test orchestrator runs under Node (brittle-node); only the worker
// runs under Bare. This is the most faithful two-client harness.

const WORKER_ENTRY = path.resolve('src/worker/main.js')

function tmp (label) {
  const dir = path.join(os.tmpdir(), `mirall-peer-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Poll until OS process `pid` is gone (signal 0 = existence probe; ESRCH ⇒ dead).
// Used to assert a worker subprocess actually exits — a worker that survives is
// the same orphan-at-100%-CPU bug we guard against in production.
export async function waitForWorkerExit (pid, ms = 5000, every = 50) {
  const start = Date.now()
  for (;;) {
    try { process.kill(pid, 0) } catch { return true }
    if (Date.now() - start > ms) return false
    await new Promise((r) => setTimeout(r, every))
  }
}

// Backstop mirroring production's process.on('exit') reaper. brittle-node runs the
// whole flow suite in one process; an uncaught error (e.g. an `until` timeout)
// aborts it before pending teardowns run, which would orphan every live worker
// subprocess — and those orphans then starve the machine and flake later runs.
// Track live children and SIGKILL any survivors when the orchestrator exits.
const liveChildren = new Set()
let exitBackstopInstalled = false
function installExitBackstop () {
  if (exitBackstopInstalled) return
  exitBackstopInstalled = true
  process.on('exit', () => {
    for (const child of liveChildren) { try { child.kill('SIGKILL') } catch {} }
  })
}

export async function launchPeer (t, { bootstrap, displayName = 'Peer', debug = false, storage, downloads, flags = {} } = {}) {
  // When storage/downloads are passed in, the caller owns their lifetime (used
  // to relaunch a peer with the same identity + drive after an offline window).
  const ownsDirs = !storage
  // Mirror production layout: the corestore lives at <userData>/app-storage, so
  // identity.enc (which the worker writes to dirname(storagePath)) lands in the
  // peer's OWN dir. A bare tmp('store') would put it in the shared os.tmpdir(),
  // where peers with different KEKs collide on one identity.enc and fail to boot
  // in identity mode.
  storage = storage || path.join(tmp('peer'), 'app-storage')
  downloads = downloads || tmp('dl')
  const sidecar = new Sidecar(WORKER_ENTRY)
  installExitBackstop()
  const child = sidecar._process
  if (child) {
    liveChildren.add(child)
    sidecar.on('exit', () => liveChildren.delete(child))
  }

  // Capture stderr (where the logger's warn/error land) so tests can assert on log
  // noise; the listener also drains the pipe so its buffer never blocks the worker.
  const stderrChunks = []
  sidecar.stderr.on('data', (d) => {
    stderrChunks.push(d.toString())
    if (debug) process.stderr.write(d)
  })
  if (debug) {
    sidecar.stdout.on('data', (d) => process.stdout.write(d))
  } else {
    sidecar.stdout.resume()
  }

  const pending = new Map()
  const listeners = new Map()
  let id = 0
  let buf = ''
  let alive = true

  function die (reason) {
    if (!alive) return
    alive = false
    const err = new Error('peer not available: ' + reason)
    for (const { reject } of pending.values()) reject(err)
    pending.clear()
  }
  sidecar.on('end', () => die('end'))
  sidecar.on('close', () => die('close'))
  sidecar.on('error', () => die('error'))

  sidecar.on('data', (chunk) => {
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'response' && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(Object.assign(new Error(msg.error), { code: msg.code }))
        else resolve(msg.data)
      } else if (typeof msg.type === 'string' && msg.type.startsWith('event:')) {
        for (const cb of listeners.get(msg.type) ?? []) cb(msg)
        for (const cb of listeners.get('*') ?? []) cb(msg)
      }
    }
  })

  const peer = {
    storage,
    downloads,
    sidecar,
    request (type, args = {}) {
      if (!alive) return Promise.reject(new Error('peer not available (killed)'))
      return new Promise((resolve, reject) => {
        const mid = 'r' + (id++)
        pending.set(mid, { resolve, reject })
        sidecar.write(JSON.stringify({ id: mid, type, ...args }) + '\n')
      })
    },
    on (type, cb) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(cb)
    },
    waitFor (type, pred = () => true, ms = 20000) {
      const deadline = scaled(ms)
      return new Promise((resolve, reject) => {
        let seen = 0
        const to = setTimeout(() => {
          reject(new Error(
            `timeout waiting for ${type} after ${deadline}ms (${displayName}: saw ${seen} ${type} event(s), none matched)\n` +
            `--- ${displayName} worker stderr (tail) ---\n${tail(stderrChunks.join(''))}`
          ))
        }, deadline)
        peer.on(type, (m) => { seen++; if (pred(m)) { clearTimeout(to); resolve(m) } })
      })
    },
    // Everything the worker has written to stderr so far (logger warn/error).
    readStderr () { return stderrChunks.join('') },
    // Hard-disconnect: kills the worker subprocess (simulates going offline).
    kill () { die('killed'); try { sidecar.destroy() } catch {} },
    // Poll a request until `pred(result)` holds (for eventually-consistent state).
    async until (type, args, pred, { ms = 20000, every = 150 } = {}) {
      const deadline = scaled(ms)
      const start = Date.now()
      let last = null
      let lastErr = null
      for (;;) {
        last = await peer.request(type, args).then((r) => r, (e) => { lastErr = e; return null })
        if (last != null && pred(last)) {
          if (TIMING && Date.now() - start > 1000) {
            console.error(`[timing] until(${type}) on ${displayName} resolved in ${Date.now() - start}ms`)
          }
          return last
        }
        if (Date.now() - start > deadline) {
          throw new Error(
            `until() timed out on ${type} after ${deadline}ms (${displayName}).\n` +
            `  last value: ${summarize(last)}\n` +
            (lastErr ? `  last request error: ${lastErr.message}\n` : '') +
            `--- ${displayName} worker stderr (tail) ---\n${tail(stderrChunks.join(''))}`
          )
        }
        await new Promise((r) => setTimeout(r, every))
      }
    },
  }

  // Boot: attach listeners (above) are live, send the bootstrap line, await ready.
  const ready = peer.waitFor('event:worker-ready')
  sidecar.write(JSON.stringify({
    type: 'bootstrap',
    storage,
    appVersion: '0.0.0-test',
    dev: true,
    verbose: false,
    downloadFolder: downloads,
    dhtBootstrap: bootstrap,
    // Feature-flag overrides (default off). main.js derives these from
    // feature-flags.json in production; tests pass them explicitly.
    ...flags,
  }) + '\n')
  await ready
  // Fresh store has no profile → give the peer an identity.
  await peer.request('profile:set', { displayName, avatar: null })

  t.teardown(async () => {
    const pid = sidecar?._process?.pid
    if (alive) { try { await peer.request('shutdown') } catch {} }
    die('teardown')
    try { sidecar.destroy() } catch {} // SIGTERM via bare-sidecar _destroy
    // Guarantee the worker is reaped: a wedged worker (busy-looped event loop)
    // ignores both the graceful shutdown IPC and the SIGTERM bare dispatches on
    // that loop, and would orphan itself at 100% CPU — exactly the production
    // bug. Wait briefly, then force an uncatchable SIGKILL so the suite can never
    // accumulate orphans, and flag it loudly (brittle forbids assertions in
    // teardown; the dedicated worker-shutdown test is the hard regression guard).
    if (pid) {
      const exited = await waitForWorkerExit(pid, 4000)
      if (!exited) {
        try { process.kill(pid, 'SIGKILL') } catch {}
        console.error(`[peer] WORKER LEAK: pid ${pid} survived graceful shutdown + SIGTERM — SIGKILLed (see worker-shutdown.test.js)`)
      }
    }
    if (ownsDirs) {
      try { fs.rmSync(storage, { recursive: true, force: true }) } catch {}
      try { fs.rmSync(downloads, { recursive: true, force: true }) } catch {}
    }
  })

  return peer
}

// A creates a space, invites B, B joins; resolves once both peers have
// exchanged a handshake (each sees the other join). Returns the spaceId.
export async function connectInSpace (t, A, B, name = 'Test Space') {
  const space = await A.request('space:create', { name })
  const inviteCode = await A.request('space:invite', { spaceId: space.spaceId })
  const aSawB = A.waitFor('event:member-joined', (m) => m.spaceId === space.spaceId)
  const bSawA = B.waitFor('event:member-joined', (m) => m.spaceId === space.spaceId)
  await B.request('space:join', { inviteCode })
  await Promise.all([aSawB, bSawA])

  // `event:member-joined` fires before the membership row is persisted, so a
  // spaces:list query right after this returns can still miss the peer. Locally
  // the write lands in time; under CI's slower scheduling it loses the race and
  // the caller's "sees the other as a member" assertion flakes. Wait until each
  // side has actually persisted the other before returning — the same guard
  // addPeerToSpace relies on.
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const persisted = (key) => (list) => {
    const s = list.find((x) => x.spaceId === space.spaceId)
    return !!(s && s.members.some((m) => m.publicKey === key))
  }
  await A.until('spaces:list', {}, persisted(bKey), { ms: 30000, every: 1000 })
  await B.until('spaces:list', {}, persisted(aKey), { ms: 30000, every: 1000 })

  return space.spaceId
}

// v2 (membership-approval) variant: A creates an encrypted space, B joins → pending,
// A receives the join request and approves it, then both converge as members.
// Both peers must be launched with { identityKEK, membershipApprovalEnabled: true }.
export async function connectInSpaceWithApproval (t, A, B, name = 'Secure Space') {
  const space = await A.request('space:create', { name })
  const inviteCode = await A.request('space:invite', { spaceId: space.spaceId })
  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId)
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await B.request('space:join', { inviteCode })
  const req = await aGotRequest
  await A.request('space:approve-member', { spaceId: space.spaceId, publicKey: req.publicKey })
  await bGranted

  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const persisted = (key) => (list) => {
    const s = list.find((x) => x.spaceId === space.spaceId)
    return !!(s && s.members.some((m) => m.publicKey === key && m.status !== 'pending'))
  }
  await A.until('spaces:list', {}, persisted(bKey), { ms: 30000, every: 1000 })
  await B.until('spaces:list', {}, persisted(aKey), { ms: 30000, every: 1000 })

  return space.spaceId
}

// Wait until a peer's space catalog (files:list) contains `filePath`, returning
// the matched entry. Distinct from fixtures.js `waitForFile`, which polls the
// filesystem for a materialized mirror file — this polls the in-app catalog.
// `event:files-updated` can fire before a peer's freshly published entry is
// actually readable from the replicated drive, and files:list no longer blocks
// on replication (it bounds each peer-drive read under a budget), so polling —
// not a single list after one event — is the reliable wait.
export async function waitForCatalogEntry (peer, spaceId, filePath, { ms = 60000, every = 250 } = {}) {
  let entry
  await peer.until('files:list', { spaceId }, (list) => {
    entry = list.find((f) => f.path === filePath)
    return !!entry
  }, { ms, every })
  return entry
}

// Add a further peer to an existing space (for 3+-peer flows). `owner` is the peer
// that mints the invite. In a 3+-peer topic the joiner can connect to a non-owner
// co-member first, and `member-joined` fires before membership is persisted — so
// we explicitly wait until the joiner has *persisted the owner* as a member, which
// is what it actually needs before it can replicate the owner's drive.
export async function addPeerToSpace (owner, joiner, spaceId) {
  const ownerKey = (await owner.request('profile:get')).publicKey
  const inviteCode = await owner.request('space:invite', { spaceId })
  const ownerSaw = owner.waitFor('event:member-joined', (m) => m.spaceId === spaceId, 120000)
  await joiner.request('space:join', { inviteCode })
  await ownerSaw
  await joiner.until('spaces:list', {}, (list) => {
    const s = list.find((x) => x.spaceId === spaceId)
    return !!(s && s.members.some((m) => m.publicKey === ownerKey))
  }, { ms: 30000, every: 1000 })
}

// v2 (membership-approval) variant of addPeerToSpace: add a 3rd+ peer to an EXISTING
// approval space — the joiner lands pending, the owner approves it, both converge as
// members. Needed for multi-peer loose tests (loose discovery rides the approval SCK
// handout, so a pending joiner can't list the encrypted catalog). Returns the joiner's key.
export async function addApprovedPeer (owner, joiner, spaceId) {
  const ownerKey = (await owner.request('profile:get')).publicKey
  const joinerKey = (await joiner.request('profile:get')).publicKey
  const inviteCode = await owner.request('space:invite', { spaceId })
  const ownerGotRequest = owner.waitFor('event:member-join-request', (m) => m.spaceId === spaceId, 120000)
  const granted = joiner.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await joiner.request('space:join', { inviteCode })
  const req = await ownerGotRequest
  await owner.request('space:approve-member', { spaceId, publicKey: req.publicKey })
  await granted
  await joiner.until('spaces:list', {}, (list) => {
    const s = list.find((x) => x.spaceId === spaceId)
    return !!(s && s.members.some((m) => m.publicKey === ownerKey && m.status !== 'pending'))
  }, { ms: 30000, every: 1000 })
  return joinerKey
}

