import test from 'brittle'
import { folderRouteState } from '../../src/renderer/model/folder-route-state.js'

test('REGRESSION (FIX-325): a share found while its role is still settling is held, not shown', (t) => {
  t.is(folderRouteState({ found: true, loading: true }), 'hold')
})

test('folderRouteState: a settled share is shown', (t) => {
  t.is(folderRouteState({ found: true, loading: false }), 'show')
})

test('folderRouteState: an absent share is missing only once the reads have settled', (t) => {
  t.is(folderRouteState({ found: false, loading: true }), 'hold')
  t.is(folderRouteState({ found: false, loading: false }), 'missing')
})
