import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret, createLocalBee } from '../../src/shared/core/store.js'
import { tmpDir } from '../helpers/bare-tmp.js'

async function rawContains(core, needle) {
  for (let i = 0; i < core.length; i++) {
    const blk = await core.get(i, { decrypt: false })
    if (blk && b4a.toString(blk).includes(needle)) return true
  }
  return false
}

test('REGRESSION (MIR-40): createLocalBee is encrypted at rest, decrypts in-process', async (t) => {
  const M = b4a.from('44'.repeat(32), 'hex')
  const root = tmpDir('mir40-enc')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  await openStore(path.join(root, 'app-storage'))
  setMasterSecret(M)
  const bee = createLocalBee('spaces-meta')
  await bee.put('space/abc', { name: 'Top Secret Project', topic: 'deadbeef'.repeat(8) })

  t.absent(await rawContains(bee.core, 'Top Secret Project'), 'space name NOT in any plaintext block')
  t.absent(await rawContains(bee.core, 'space/abc'), 'key NOT in plaintext')
  t.is((await bee.get('space/abc')).value.name, 'Top Secret Project', 'decrypts in-process')

  await getStore().close()
})

test('REGRESSION (MIR-40): insecure mode (no M) keeps the bee plaintext (unchanged)', async (t) => {
  const root = tmpDir('mir40-plain')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  await openStore(path.join(root, 'app-storage'))
  setMasterSecret(null)
  const bee = createLocalBee('spaces-meta')
  await bee.put('space/abc', { name: 'Visible Name' })

  t.ok(await rawContains(bee.core, 'Visible Name'), 'plaintext present without M (test/insecure fallback)')

  await getStore().close()
})

test('REGRESSION (MIR-40): createLocalBee rejects an unregistered bee name', async (t) => {
  const root = tmpDir('mir40-reject')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  await openStore(path.join(root, 'app-storage'))
  setMasterSecret(b4a.from('cd'.repeat(32), 'hex'))
  t.exception(() => createLocalBee('not-a-local-bee'), /unregistered local bee/)

  await getStore().close()
})
