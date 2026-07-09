import test from 'brittle'
import notifications from '../../src/main/notifications.js'

const { toastSafeId } = notifications

// A peer public key as it appears in notification ids: 64 hex chars.
const PUBKEY = 'a'.repeat(64)

test('short id passes through unchanged', (t) => {
  t.is(toastSafeId('first-hide-notice'), 'first-hide-notice')
  t.is(toastSafeId('member-left:short'), 'member-left:short')
})

test('id at exactly the 64-char limit passes through unchanged', (t) => {
  const id = 'x'.repeat(64)
  t.is(id.length, 64)
  t.is(toastSafeId(id), id)
})

test('REGRESSION (FIX-1): member-joined id with a 64-hex public key is clamped to <= 64 UTF-16 chars', (t) => {
  // `member-joined:<64-hex-pubkey>` = 78 chars. On Windows the `id` option maps
  // to the toast Tag (64 UTF-16 limit) and Electron's Notification constructor
  // throws above that — the original crash. The clamped id must fit.
  const id = `member-joined:${PUBKEY}`
  t.ok(id.length > 64, 'precondition: the real id overflows the Windows limit')
  t.ok(toastSafeId(id).length <= 64, 'clamped id fits the Windows toast Tag limit')
})

test('long transferId-based id (spaceId|shareId|relPath) is clamped to <= 64', (t) => {
  const transferId = `${'b'.repeat(16)}|share-1234|some/deeply/nested/path/to/a/large file.mov`
  const id = `transfer-complete:${transferId}`
  t.ok(id.length > 64, 'precondition: transfer ids embed full paths and overflow')
  t.ok(toastSafeId(id).length <= 64)
})

test('clamping is deterministic — same logical id yields the same Tag (toast replacement)', (t) => {
  const id = `member-joined:${PUBKEY}`
  t.is(toastSafeId(id), toastSafeId(id))
})

test('distinct over-long ids that share a >64-char prefix map to distinct Tags', (t) => {
  // Naive truncate-to-64 would collide here (identical first 64 chars), which
  // would make two different notifications overwrite each other. Hashing avoids it.
  const common = `member-joined:${'d'.repeat(60)}`
  t.ok(common.length > 64)
  t.not(toastSafeId(`${common}AAAA`), toastSafeId(`${common}BBBB`))
})

test('over-long id keeps its kind prefix for debuggability', (t) => {
  const safe = toastSafeId(`transfer-error:${'c'.repeat(80)}`)
  t.ok(safe.startsWith('transfer-error:'))
  t.ok(safe.length <= 64)
})
