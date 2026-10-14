import test from 'brittle'
import { admitPeer } from '../../src/shared/core/peer-admission.js'

const unix = { platform: 'linux', uid: 501 }
const win = { platform: 'win32', uid: -1 }
const creds = (over) => ({ pid: 42, uid: 501, gid: 20, sid: null, ...over })

test('Unix admits the owning user and nobody else, root included', (t) => {
  t.alike(admitPeer(creds(), unix), { ok: true })
  t.alike(admitPeer(creds({ uid: 502 }), unix), { ok: false, reason: 'foreign-uid' })
  t.alike(admitPeer(creds({ uid: 0 }), unix), { ok: false, reason: 'foreign-uid' })
  t.alike(admitPeer(creds({ uid: null }), unix), { ok: false, reason: 'foreign-uid' })
})

test('no credentials is no admission', (t) => {
  t.alike(admitPeer(null, unix), { ok: false, reason: 'no-credentials' })
  t.alike(admitPeer(null, win), { ok: false, reason: 'no-credentials' })
})

test('Windows refuses a remote peer and one it could not identify', (t) => {
  t.alike(admitPeer(creds({ uid: null, sid: 'S-1-5-21-1' }), win), { ok: true })
  t.alike(admitPeer(creds({ uid: null, pid: null, sid: null }), win), { ok: false, reason: 'remote' })
  t.alike(admitPeer(creds({ uid: null, sid: null }), win), { ok: false, reason: 'unidentified' })
})
