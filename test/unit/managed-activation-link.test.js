import test from 'brittle'
import b4a from 'b4a'
import z32 from 'z32'
import vectors from '../fixtures/managed/activation-link-v1.json' with { type: 'json' }
import { decodeActivationCode, apiUrlOk, encodeActivationCode } from '../../src/shared/managed/activation-link.js'
import { extractActivationCode, looksLikeActivationCode } from '../../src/shared/contract/activation-syntax.js'

const lever = (v) => v.loopbackLever === true

test('every valid Console vector decodes to its license key, drive key and apiUrl', (t) => {
  for (const v of vectors.valid) {
    const got = decodeActivationCode(v.code, { allowHttp: lever(v) })
    t.ok(got, v.name)
    t.is(b4a.toString(got.licenseKey, 'hex'), vectors.licenseKeyBytes, v.name)
    t.is(b4a.toString(got.driveKey, 'hex'), vectors.driveKey, v.name)
    t.is(got.apiUrl, v.apiUrl, v.name)
  }
})

test('every invalid Console vector is refused, with the lever where the case names it', (t) => {
  for (const v of vectors.invalid) t.is(decodeActivationCode(v.code, { allowHttp: lever(v) }), null, `${v.name} (${v.refusedBy})`)
})

test('a loopback apiUrl needs the lever', (t) => {
  for (const v of vectors.valid.filter(lever)) t.is(decodeActivationCode(v.code), null, v.name)
})

test('apiUrl follows the Console rule', (t) => {
  t.ok(apiUrlOk('https://api.mirall.app'))
  t.ok(apiUrlOk('https://api.mirall.app:8443'))
  for (const bad of ['https://api.mirall.app/', 'https://api.mirall.app/v1', 'https://x.example?y=1', 'https://x.example#f', 'https://u:p@x.example', 'http://api.mirall.app', 'https://abc.supabase.co', 'https://abc.supabase.co.', 'https://supabase.co', 'https://ABC.SUPABASE.CO', 'ftp://x.example', 'http://127.0.0.1:54321']) t.absent(apiUrlOk(bad), bad)
  t.ok(apiUrlOk('http://127.0.0.1:54321', { allowHttp: true }))
  t.absent(apiUrlOk('http://localhost:54321', { allowHttp: true }))
})

test('extract requires a/ and accepts every live form', (t) => {
  const code = vectors.valid[0].code
  for (const form of [`mirall://license/a/${code}`, `MIRALL://LICENSE/a/${code}`, `https://link.mirall.app/license#a/${code}`, `https://link-staging.mirall.app/link/license#a/${code}`, `a/${code}`, `mirall://license/a/${code}/`]) t.is(extractActivationCode(form), code, form)
  for (const bad of ['mirall://license/k/MRL-AAAAA', `mirall://license/${code}`, `mirall://join/a/${code}`, `https://x.example/space#a/${code}`, 'https://x.example/license#a/%E0%A4%A', '', 42]) t.is(extractActivationCode(bad), null, String(bad))
})

test('looksLikeActivationCode checks the alphabet and the length only', (t) => {
  t.ok(looksLikeActivationCode(vectors.valid[0].code))
  t.absent(looksLikeActivationCode('0' + vectors.valid[0].code.slice(1)))
  t.absent(looksLikeActivationCode('y'.repeat(513)))
  t.absent(looksLikeActivationCode(''))
})

test('one flipped bit anywhere fails the checksum', (t) => {
  const bytes = z32.decode(vectors.valid[0].code.toLowerCase())
  for (let i = 0; i < bytes.byteLength; i++) {
    const flipped = b4a.from(bytes)
    flipped[i] ^= 1
    t.is(decodeActivationCode(z32.encode(flipped)), null, `byte ${i}`)
  }
})

test('encode round-trips the https vectors', (t) => {
  for (const v of vectors.valid.filter((x) => !lever(x) && x.code === x.code.toLowerCase())) {
    const decoded = decodeActivationCode(v.code)
    t.is(encodeActivationCode(decoded), v.code, v.name)
  }
})
