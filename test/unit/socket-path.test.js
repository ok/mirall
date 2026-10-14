import test from 'brittle'
import { socketPaths, SUN_PATH_MAX } from '../../src/shared/core/socket-path.js'

const HASH = 'ab'.repeat(32)
const base = { storageHash: HASH, uid: 501, tmpdir: '/tmp' }

test('a short data directory listens and locks in its own run directory', (t) => {
  for (const platform of ['darwin', 'linux']) {
    const paths = socketPaths({ ...base, platform, dataDir: '/home/u/.config/Mirall' })
    t.alike(paths, {
      runDir: '/home/u/.config/Mirall/run',
      lock: '/home/u/.config/Mirall/run/daemon.lock',
      socket: '/home/u/.config/Mirall/run/daemon.sock',
      socketDir: '/home/u/.config/Mirall/run',
    }, platform)
  }
})

test('a socket path past sun_path moves under the temp root, named by the store; the lock does not', (t) => {
  const dataDir = '/d/' + 'x'.repeat(SUN_PATH_MAX)
  const paths = socketPaths({ ...base, platform: 'darwin', dataDir })
  t.is(paths.socket, '/tmp/mirall-501/' + HASH.slice(0, 16) + '.sock')
  t.is(paths.socketDir, '/tmp/mirall-501')
  t.is(paths.lock, dataDir + '/run/daemon.lock')
})

test('the limit is counted in bytes, not characters', (t) => {
  const tail = '/run/daemon.sock'
  const fits = '/' + 'a'.repeat(SUN_PATH_MAX - tail.length - 1)
  t.is(socketPaths({ ...base, platform: 'linux', dataDir: fits }).socketDir, fits + '/run', 'exactly at the limit')
  const accented = '/' + '\u00e9'.repeat(Math.ceil((SUN_PATH_MAX - tail.length) / 2))
  t.is(socketPaths({ ...base, platform: 'linux', dataDir: accented }).socketDir, '/tmp/mirall-501',
    'two-byte characters push a path that is short in characters past the limit')
})

test('Windows names a pipe per store and keeps the lock beside it', (t) => {
  const a = socketPaths({ ...base, platform: 'win32', dataDir: 'C:\\Users\\u\\AppData\\Roaming\\Mirall' })
  t.is(a.socket, '\\\\.\\pipe\\mirall-' + HASH.slice(0, 32))
  t.is(a.socketDir, null)
  t.is(a.lock, 'C:\\Users\\u\\AppData\\Roaming\\Mirall\\run\\daemon.lock')
  const b = socketPaths({ ...base, storageHash: 'cd'.repeat(32), platform: 'win32', dataDir: 'C:\\x' })
  t.not(b.socket, a.socket, 'another store, another pipe')
})
