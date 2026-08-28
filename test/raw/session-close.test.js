import test from 'brittle'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'hypercore-crypto'

// Trust-but-verify of the hypercore primitive the peer-bee read bracket depends on: closing ONE
// session of a core that has other sessions must leave the core open and readable. If this ever
// stops holding, every bounded peer read would tear down a member view's follow.
function tmpStore (t) {
  const dir = path.join(os.tmpdir(), 'raw-sess-' + crypto.randomBytes(6).toString('hex'))
  fs.mkdirSync(dir, { recursive: true })
  const store = new Corestore(dir)
  t.teardown(async () => {
    try { await store.close() } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return store
}

test('closing one session of a core with siblings keeps the core open and readable', async (t) => {
  const store = tmpStore(t)
  await store.ready()
  const writer = store.get({ name: 'p' })
  await writer.ready()
  const bee = new Hyperbee(writer, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.put('displayName', 'Held')

  const holder = store.get({ key: writer.key })
  await holder.ready()
  const transient = store.get({ key: writer.key })
  await transient.ready()
  t.ok(holder.sessions.length >= 2, 'both sessions share one core')

  await transient.close()
  t.absent(holder.closed, 'the sibling session is untouched')
  const held = new Hyperbee(holder, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  t.is((await held.get('displayName'))?.value, 'Held', 'and it still reads')
  await holder.close()
  await bee.close()
})
