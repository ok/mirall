import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import mod from '../../src/main/storage-perms.js'

const { hardenStorageDirs } = mod
const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001'

function profileDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-perms-'))
  return { dataDir, storage: path.join(dataDir, 'app-storage') }
}

function quietLog() {
  const errors = []
  return { errors, error: (...args) => errors.push(args.join(' ')) }
}

function windowsExec(calls, { whoami = `"desktop-1\\\\a","${SID}"\r\n`, icacls = null } = {}) {
  return async (cmd, args) => {
    calls.push([cmd, args])
    if (cmd === 'whoami') return { stdout: whoami }
    if (icacls) throw icacls
    return { stdout: '' }
  }
}

test('POSIX: the store directory is owner-only', async (t) => {
  const chmods = []
  await hardenStorageDirs('/x/app-storage', { platform: 'darwin', chmodSync: (p, mode) => chmods.push([p, mode]), execFile: () => t.fail('no icacls') })
  t.alike(chmods, [['/x/app-storage', 0o700]])
})

test('Windows: the user data folder gets this process\'s SID and SYSTEM, inheritance removed, once', async (t) => {
  const { dataDir, storage } = profileDir()
  const calls = []
  await hardenStorageDirs(storage, { platform: 'win32', execFile: windowsExec(calls), chmodSync: () => t.fail('no chmod') })
  t.alike(calls, [
    ['whoami', ['/user', '/fo', 'csv', '/nh']],
    ['icacls', [dataDir, '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']],
  ])

  const again = []
  await hardenStorageDirs(storage, { platform: 'win32', execFile: windowsExec(again) })
  t.alike(again, [], 'an applied ACL is not pushed down every file again')
})

test('a failure is logged, never thrown, and is tried again next launch', async (t) => {
  const log = quietLog()
  const { storage } = profileDir()
  await hardenStorageDirs(storage, { platform: 'win32', execFile: windowsExec([], { icacls: new Error('access denied') }), log })
  await hardenStorageDirs(storage, { platform: 'win32', execFile: windowsExec([], { whoami: 'no sid here' }), log })
  await hardenStorageDirs(storage, { platform: 'linux', chmodSync: () => { throw new Error('EPERM') }, log })
  t.is(log.errors.length, 3)
  const calls = []
  await hardenStorageDirs(storage, { platform: 'win32', execFile: windowsExec(calls) })
  t.is(calls.length, 2, 'no marker was written for the failed attempts')
})
