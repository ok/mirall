import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { listPeerShare, collectPeerShare, getPeerEntry, watchPeerCatalog } from '../../src/shared/shares/share-catalog.js'

// REGRESSION (FIX-327): a peer catalog key is self-asserted by a peer (its handshake or its
// profile bee), so it can be malformed or a non-hex type. A wrong-length/typed key threw
// synchronously out of store.get (b4a.from → non-32-byte buffer → "ID must be 32-bytes long"),
// and because the loose listing has no per-member guard, that broke the ENTIRE files:list for the
// space. openPeerCatalog now validates + lowercase-normalizes the key at the single sink every
// peer-catalog read funnels through, so a bad key degrades to "no such catalog" instead of throwing.
test('REGRESSION (FIX-327): a malformed peer catalog key degrades to empty, never throws', async (t) => {
  await freshPeer(t)
  const BAD_KEYS = [
    ['a'.repeat(64)], // non-string that String()-coerces to 64 hex (the handshake-guard bypass)
    'abcd',           // hex but wrong length
    'z'.repeat(64),   // right length, non-hex
    'A'.repeat(64),   // uppercase (non-canonical) — would open a duplicate core
    null, undefined, 123, {}, // non-strings
  ]
  for (const key of BAD_KEYS) {
    const label = JSON.stringify(key) ?? String(key)
    t.alike(await listPeerShare(key, '__loose__'), [], `listPeerShare(${label}) → [] (no throw)`)
    const share = await collectPeerShare(key, '__loose__')
    t.is(share.complete, false, `collectPeerShare(${label}).complete === false`)
    t.alike(share.entries, [], `collectPeerShare(${label}).entries === []`)
    t.is(await getPeerEntry(key, '__loose__', 'x.txt'), null, `getPeerEntry(${label}) → null`)
    watchPeerCatalog(key, 'loose', () => {})
    t.pass(`watchPeerCatalog(${label}) did not throw`)
  }
})
