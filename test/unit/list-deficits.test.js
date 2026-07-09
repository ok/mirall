import test from 'brittle'
import { markListIncomplete, takeIncompleteListSpaces } from '../../src/shared/transfer/list-deficits.js'

test('take-semantics: marked spaces are returned once, deduped, and cleared', (t) => {
  takeIncompleteListSpaces()
  markListIncomplete('a')
  markListIncomplete('b')
  markListIncomplete('a')
  t.alike(takeIncompleteListSpaces().sort(), ['a', 'b'], 'each marked space once')
  t.alike(takeIncompleteListSpaces(), [], 'drained after take')
  markListIncomplete(null)
  markListIncomplete('')
  t.alike(takeIncompleteListSpaces(), [], 'falsy space ids are ignored')
})
