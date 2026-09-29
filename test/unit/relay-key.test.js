import test from 'brittle'
import { truncateRelayKey } from '../../src/shared/contract/relay-key.js'

test('a relay key shows its first eight and last six characters', (t) => {
  t.is(truncateRelayKey('yry4bqaudkr5bn9wf7pjfka1rf6m6r7yb9c4e7t5j8njbke6xk7q'), 'yry4bqau…e6xk7q')
})

test('a key of sixteen characters or fewer is shown whole', (t) => {
  t.is(truncateRelayKey('abcdefghijklmnop'), 'abcdefghijklmnop')
  t.is(truncateRelayKey('short'), 'short')
})
