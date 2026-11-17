import test from 'brittle'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { createRequire } from 'module'
import { tmpDir } from '../helpers/tmp.js'

const require = createRequire(import.meta.url)
const { readRunRecord, probeRunRecord, discoverBackend, openIdentity } = require('../../src/main/backend-discovery.js')
const { pipeOwnedBySelf } = require('../../src/main/pipe-owner.js')

const PIPE = '\\\\.\\pipe\\mirall-0123456789abcdef0123456789abcdef'
const ack = (appVersion) => async () => ({ type: 'hello-ack', ok: true, appVersion })
const windowsRecord = (socket = PIPE) => ({ file: 'C:\\Users\\me\\AppData\\Roaming\\Mirall\\run\\daemon.json', record: { socket, pid: 4242, version: '1.14.0' } })

// The seam the Windows owner check fills: whatever reads a pipe's owner is injected, and only a
// verified owner lets main use the pipe.
test('on Windows a pipe is used only when its owner is verified as this user', async (t) => {
  const greeted = []
  const greet = async (socket) => { greeted.push(socket); return { appVersion: '1.14.0' } }
  t.alike(await probeRunRecord(windowsRecord(), { version: '1.14.0', platform: 'win32', pipeOwned: async () => true, greet }), { verdict: 'attach', socket: PIPE })
  t.alike(await probeRunRecord(windowsRecord(), { version: '1.14.0', platform: 'win32', pipeOwned: async () => false, greet }), { verdict: 'none' }, 'an owner that is not this user')
  t.alike(await probeRunRecord(windowsRecord(), { version: '1.14.0', platform: 'win32', pipeOwned: async () => { throw new Error('no access') }, greet }), { verdict: 'none' }, 'an owner that cannot be read')
  t.alike(await probeRunRecord(windowsRecord('C:\\temp\\daemon.sock'), { version: '1.14.0', platform: 'win32', pipeOwned: async () => true, greet }), { verdict: 'none' }, 'a name that is not a pipe')
  t.alike(greeted, [PIPE], 'nothing is said to a pipe that failed the check')
})

test('as built, no pipe’s owner can be verified, so Windows never uses a back end it did not start', async (t) => {
  t.is(await pipeOwnedBySelf(PIPE), false)
  t.alike(await probeRunRecord(windowsRecord(), { version: '1.14.0', platform: 'win32', greet: ack('1.14.0') }), { verdict: 'none' })
})

test('the version must be the same text, beta number included', async (t) => {
  const opts = { platform: 'win32', pipeOwned: async () => true }
  t.is((await probeRunRecord(windowsRecord(), { ...opts, version: '1.14.0-beta.3', greet: ack('1.14.0-beta.3') })).verdict, 'attach')
  t.alike(await probeRunRecord(windowsRecord(), { ...opts, version: '1.14.0-beta.3', greet: ack('1.14.0-beta.2') }), { verdict: 'other-version', version: '1.14.0-beta.2' })
  t.alike(await probeRunRecord(windowsRecord(), { ...opts, version: '1.14.0', greet: async () => ({ type: 'hello-ack', ok: true }) }), { verdict: 'other-version', version: null }, 'an ack that states none')
  t.alike(await probeRunRecord(windowsRecord(), { ...opts, version: '1.14.0', greet: async () => { throw new Error('closed') } }), { verdict: 'none' }, 'no ack at all is no back end')
})

// A profile's run folder on this machine, with a real socket in it.
async function profile(t) {
  const dataDir = tmpDir('bd', t)
  const runDir = path.join(dataDir, 'run')
  fs.mkdirSync(runDir, { mode: 0o700 })
  const socket = path.join(runDir, 'daemon.sock')
  const server = net.createServer((sock) => sock.on('error', () => {}))
  await new Promise((resolve) => server.listen(socket, resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  const write = (record) => fs.writeFileSync(path.join(runDir, 'daemon.json'), JSON.stringify({ v: 1, pid: 4242, version: '1.14.0', socket, ...record }))
  return { storage: path.join(dataDir, 'app-storage'), runDir, socket, write }
}

test('on POSIX the record’s folder and the socket must be this user’s, and the path a socket', { skip: process.platform === 'win32' }, async (t) => {
  const p = await profile(t)
  const opts = { version: '1.14.0', greet: ack('1.14.0') }
  t.is(readRunRecord(p.storage), null, 'no record, nothing read')
  p.write({})
  t.alike(await discoverBackend(p.storage, opts), { verdict: 'attach', socket: p.socket })

  p.write({ socket: 'run/daemon.sock' })
  t.is((await discoverBackend(p.storage, opts)).verdict, 'none', 'a relative path')
  const plain = path.join(p.runDir, 'plain')
  fs.writeFileSync(plain, '')
  p.write({ socket: plain })
  t.is((await discoverBackend(p.storage, opts)).verdict, 'none', 'a file that is not a socket')

  p.write({})
  fs.chmodSync(p.runDir, 0o750)
  t.is((await discoverBackend(p.storage, opts)).verdict, 'none', 'a run folder its group can read')
  fs.chmodSync(p.runDir, 0o700)

  fs.writeFileSync(path.join(p.runDir, 'daemon.json'), '{not json')
  t.is(readRunRecord(p.storage), null, 'a record that does not parse is none')
})

test('the identity is opened only when it is not open: a key wait or a lock gets the key, an open one nothing', async (t) => {
  const key = { kek: 'ab'.repeat(32), relaySeed: 'ef'.repeat(32) }
  for (const [status, expected, opened] of [
    [{ locked: true, code: 'IDENTITY_AWAITING_KEY' }, ['identity:status', 'identity:unlock'], true],
    [{ locked: true, code: 'IDENTITY_UNLOCK_FAILED' }, ['identity:status', 'identity:unlock'], false],
    [{ locked: false, code: null }, ['identity:status'], true],
  ]) {
    const asked = []
    const request = async (_socket, type, args) => {
      asked.push(type)
      if (type === 'identity:status') return status
      t.alike(args, key, 'the key and the relay seed, nothing else')
      if (status.code === 'IDENTITY_UNLOCK_FAILED') throw Object.assign(new Error('identity unlock failed'), { code: 'IDENTITY_UNLOCK_FAILED' })
      return { ok: true }
    }
    t.is(await openIdentity('/run/daemon.sock', key, { request }), opened, String(status.code))
    t.alike(asked, expected)
  }
})
