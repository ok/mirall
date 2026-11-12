import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { spawnHeadless } from '../helpers/headless.js'
import { tmpDir } from '../helpers/tmp.js'
import { scaled } from '../helpers/timing.js'

const WORKER_EXIT_PROTOCOL_MISMATCH = 71

function dataDir(t) {
  return path.join(tmpDir('mirall-headless', t), 'profile')
}

test('a command line the back end cannot read is refused with its usage', { timeout: scaled(20000) }, async (t) => {
  const run = spawnHeadless(['--storage', dataDir(t), '--bogus'])
  t.is(await run.exited, WORKER_EXIT_PROTOCOL_MISMATCH, 'refused like a host on another protocol')
  t.ok(run.stderr().includes('unknown_flag: bogus'), 'says which argument')
  t.ok(run.stderr().includes('usage: bare src/worker/main.js'), 'and how to call it')

  const lever = spawnHeadless(['--storage', dataDir(t), '--dht-bootstrap', '127.0.0.1:1'])
  t.is(await lever.exited, WORKER_EXIT_PROTOCOL_MISMATCH, 'a test lever without --dev is refused')
})

test('started without a pipe, the back end listens beside its own store and says where', { timeout: scaled(30000) }, async (t) => {
  const dir = dataDir(t)
  const run = spawnHeadless(['--storage', dir, '--dev'])
  t.teardown(() => { run.child.kill('SIGKILL') })
  const socket = await run.listening(scaled(20000))
  t.ok(fs.existsSync(path.join(dir, 'run', 'daemon.lock')), 'the profile lock of the data folder it was given')
  t.ok(fs.statSync(socket).isSocket(), 'and the socket it names is bound')
  if (process.platform !== 'win32') {
    t.is(fs.statSync(path.join(dir, 'app-storage')).mode & 0o777, 0o700, 'the store it created is the owner\'s alone')
  }
})
