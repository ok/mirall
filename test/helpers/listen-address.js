// Where a test's stand-in for the worker listens, the way the worker itself does on this system: a
// socket file in the given directory on POSIX, a named pipe on Windows, which binds no socket to a
// file path.
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export function listenAddress(dir, name) {
  if (process.platform !== 'win32') return path.join(dir, name)
  return '\\\\.\\pipe\\mirall-test-' + randomBytes(16).toString('hex')
}
