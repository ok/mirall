import test from 'brittle'
import { foldSearchText } from '../../src/shared/contract/text-fold.js'

test('search text is lowercased and composed, so either spelling of a name folds equal', (t) => {
  t.is(foldSearchText('März'), 'märz', 'decomposed text is composed')
  t.is(foldSearchText('MÄRZ'), 'märz', 'composed text is lowercased')
  t.is(foldSearchText('MÄRZ'), foldSearchText('März'), 'case and form fold together')
  t.is(foldSearchText(foldSearchText('März')), 'märz', 'folding twice changes nothing')
})
