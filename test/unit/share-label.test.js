import test from 'brittle'
import { shareLabel } from '../../src/shared/shares/share-label.js'

test('a share is named by its display name, falling back to the on-disk name', (t) => {
  t.is(shareLabel({ name: 'Vault', displayName: 'Archive' }), 'Archive')
  t.is(shareLabel({ name: 'Vault' }), 'Vault')
  t.is(shareLabel({ name: 'Vault', displayName: '' }), 'Vault', 'an empty override is no override')
  t.is(shareLabel(null), null, 'an unreadable descriptor still yields a row, unnamed')
  t.is(shareLabel(undefined), null)
})
