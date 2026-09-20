import test from 'brittle'
import { PATH_HOST, daemonPaths } from '../../src/shared/contract/paths.js'

test('there are exactly two hosts a path can belong to', (t) => {
  t.alike(Object.values(PATH_HOST).sort(), ['client', 'daemon'])
})

test('daemonPaths tags without mutating its input', (t) => {
  const payload = { localPath: '/tmp/a.bin', transferId: 't1' }
  const tagged = daemonPaths(payload)
  t.alike(tagged, { localPath: '/tmp/a.bin', transferId: 't1', host: 'daemon' })
  t.absent('host' in payload, 'the caller’s object is untouched')
})

test('an existing host is overwritten, because the worker only ever sends its own', (t) => {
  t.is(daemonPaths({ host: 'client' }).host, 'daemon')
})
