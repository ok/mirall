import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret, getSpaceKeysVaultKey } from '../../src/shared/core/store.js'
import { wrap, unwrap } from '../../src/shared/core/identity-envelope.js'
import {
  initSpaceKeys, putContentKey, getContentKeyForEpoch, listContentKeys,
} from '../../src/shared/spaces/space-keys.js'
import { tmpDir } from '../helpers/bare-tmp.js'

// The vault's on-disk shape: a v1 file (one bare hex key per space, what every earlier release
// persists) opens as epoch 0 and is written back in the same shape while every entry is still at
// epoch 0, so a downgrade opens it; the first entry past epoch 0 moves the file to v2.

const K = (byte) => b4a.from(byte.repeat(32), 'hex')
const SPACE = 'deadbeef00000000'

async function bootStore(t, label) {
  const root = tmpDir(`vault-${label}`)
  const storagePath = path.join(root, 'app-storage')
  t.teardown(async () => {
    try { await getStore().close() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
  await openStore(storagePath)
  setMasterSecret(b4a.from('55'.repeat(32), 'hex'))
  await initSpaceKeys()
  return path.join(root, 'space-keys.enc')
}

function writeEnvelope(file, plainObj) {
  const { nonce, ciphertext } = wrap(b4a.from(JSON.stringify(plainObj)), getSpaceKeysVaultKey())
  fs.writeFileSync(file, JSON.stringify({ v: 1, nonce: b4a.toString(nonce, 'base64'), ciphertext: b4a.toString(ciphertext, 'base64') }))
}

function readPlaintext(file) {
  const env = JSON.parse(b4a.toString(fs.readFileSync(file)))
  const plain = unwrap({ nonce: b4a.from(env.nonce, 'base64'), ciphertext: b4a.from(env.ciphertext, 'base64') }, getSpaceKeysVaultKey())
  return JSON.parse(b4a.toString(plain))
}

test('a v1 space-keys.enc opens, reads as epoch 0, and stays v1 while every entry is at epoch 0', async (t) => {
  const file = await bootStore(t, 'v1-upgrade')
  writeEnvelope(file, { v: 1, entries: { [SPACE]: 'aa'.repeat(32) } })

  await initSpaceKeys()
  t.alike(getContentKeyForEpoch(SPACE, 0), K('aa'), 'the v1 entry is readable')
  t.is(getContentKeyForEpoch(SPACE, 1), null, 'no later epoch exists')
  t.is(getContentKeyForEpoch('unknown', 0), null)

  await putContentKey('cafe000000000000', K('bb'))
  const onDisk = readPlaintext(file)
  t.alike(onDisk, { v: 1, entries: { [SPACE]: 'aa'.repeat(32), cafe000000000000: 'bb'.repeat(32) } }, 'still the shape an older release reads')

  await initSpaceKeys()
  t.alike(getContentKeyForEpoch(SPACE, 0), K('aa'), 'the file re-reads the same key')
  t.alike(getContentKeyForEpoch('cafe000000000000', 0), K('bb'))
})

test('the envelope around the file stays v1 when the plaintext moves to v2', async (t) => {
  const file = await bootStore(t, 'envelope')
  await putContentKey(SPACE, K('aa'))
  await putContentKey(SPACE, K('bb'), { epoch: 1 })
  const env = JSON.parse(b4a.toString(fs.readFileSync(file)))
  t.is(env.v, 1, 'envelope version unchanged')
  t.is(readPlaintext(file).v, 2)
})

test('putContentKey at a higher epoch keeps the old key in history and listContentKeys returns both', async (t) => {
  const file = await bootStore(t, 'advance')
  await putContentKey(SPACE, K('aa'))
  await putContentKey(SPACE, K('bb'), { epoch: 1 })
  t.alike(getContentKeyForEpoch(SPACE, 0), K('aa'), 'the epoch-0 key is still held')
  t.alike(getContentKeyForEpoch(SPACE, 1), K('bb'))
  t.is(listContentKeys().length, 2, 'the leftover probe sees history keys')
  t.alike(readPlaintext(file).entries[SPACE], { epoch: 1, key: 'bb'.repeat(32), history: [{ epoch: 0, key: 'aa'.repeat(32) }] })

  await initSpaceKeys()
  t.alike(getContentKeyForEpoch(SPACE, 0), K('aa'), 'history survives a reopen')
})

test('a different key put at the current epoch replaces it, so a wrong first grant is recoverable', async (t) => {
  const file = await bootStore(t, 'replace')
  await putContentKey(SPACE, K('aa'))
  await putContentKey(SPACE, K('bb'))
  t.alike(getContentKeyForEpoch(SPACE, 0), K('bb'), 'replaced in memory')
  t.is(readPlaintext(file).entries[SPACE], 'bb'.repeat(32), 'and on disk')
  await putContentKey(SPACE, K('cc'), { epoch: 2 })
  await putContentKey(SPACE, K('dd'), { epoch: 1 })
  t.alike(getContentKeyForEpoch(SPACE, 1), K('dd'), 'a lower epoch replaces the current key')
  t.is(getContentKeyForEpoch(SPACE, 2), null, 'and drops the later one')
  t.alike(getContentKeyForEpoch(SPACE, 0), K('bb'), 'keeping the earlier ones')
})

test('the same epoch-0 key re-put (a re-grant) is a no-op that still persists cleanly', async (t) => {
  const file = await bootStore(t, 'regrant')
  await putContentKey(SPACE, K('aa'))
  await putContentKey(SPACE, K('aa'))
  await putContentKey(SPACE, K('aa'), { epoch: 0 })
  t.is(readPlaintext(file).entries[SPACE], 'aa'.repeat(32))
  t.is(listContentKeys().length, 1)
})
