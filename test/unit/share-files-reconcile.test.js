import test from 'brittle'
import { reconcileFiles } from '../../src/renderer/shareFilesReconcile.js'

const row = (relPath, extra = {}) => ({ relPath, size: 1, hash: 'h', mtime: 0, status: 'remote', ...extra })

// REGRESSION (FIX-130: a peer-catalog read can transiently return empty/partial while the owner
// indexes a large folder; a whole-list replace then blanked or shrank the view. The worker tags
// each read complete:true|false and reconcileFiles must never blank/shrink on an incomplete one.)
test('REGRESSION (FIX-130): an incomplete peer-catalog read must not blank or shrink the folder listing', (t) => {
  const prev = [row('a'), row('b'), row('c')]

  t.alike(reconcileFiles(prev, [row('a')], { complete: true }).map((f) => f.relPath), ['a'], 'complete → wholesale adopt (incl. removals)')

  t.is(reconcileFiles(prev, [], { complete: false }), prev, 'partial empty → keep prev (no blank)')

  t.alike(reconcileFiles(prev, [row('a')], { complete: false }).map((f) => f.relPath), ['a', 'b', 'c'], 'partial fewer → never shrink')

  const merged = reconcileFiles(prev, [row('b', { status: 'downloaded' }), row('d')], { complete: false })
  t.alike(merged.map((f) => f.relPath), ['a', 'b', 'c', 'd'], 'partial → adds new, sorted by relPath')
  t.is(merged.find((f) => f.relPath === 'b').status, 'downloaded', 'fresh row value wins on merge')
})

test('an unchanged incomplete read returns the prev reference (no needless re-render)', (t) => {
  const prev = [row('a'), row('b'), row('c')]
  t.is(reconcileFiles(prev, [row('a'), row('b'), row('c')], { complete: false }), prev, 'identical partial → same reference')
  t.is(reconcileFiles(prev, [row('a'), row('c')], { complete: false }), prev, 'subset partial with identical values → same reference')
})
