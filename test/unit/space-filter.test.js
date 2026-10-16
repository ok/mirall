import test from 'brittle'
import { filterSpace } from '../../src/renderer/model/space-filter.js'

const files = [{ path: '/Brief-v3.pdf' }, { path: '/Budget-2026.xlsx' }, { path: '/März.txt' }]
const shares = [{ name: 'Brand Assets' }, { name: 'handover', displayName: 'Client Handover' }]

test('an empty term passes everything through, with no match count', (t) => {
  const out = filterSpace({ files, shares }, '   ')
  t.is(out.files.length, 3)
  t.is(out.shares.length, 2)
  t.is(out.matched, null)
  t.is(out.total, 3)
})

test('a substring matches anywhere in the file name, case-insensitively', (t) => {
  const out = filterSpace({ files, shares }, 'DGET')
  t.alike(out.files.map((f) => f.path), ['/Budget-2026.xlsx'])
  t.is(out.matched, 1)
  t.is(out.total, 3, 'the count covers files only')
})

test('a decomposed name matches a composed term and the other way round', (t) => {
  t.is(filterSpace({ files, shares }, 'märz').files.length, 1, 'NFD term finds the NFC name')
  const nfd = [{ path: '/März.txt' }]
  t.is(filterSpace({ files: nfd, shares }, 'märz').files.length, 1, 'NFC term finds the NFD name')
})

test('shares are matched by their shown name as well as their on-disk name', (t) => {
  t.alike(filterSpace({ files, shares }, 'client').shares.map((s) => s.name), ['handover'])
  t.alike(filterSpace({ files, shares }, 'handover').shares.map((s) => s.name), ['handover'])
  t.alike(filterSpace({ files, shares }, 'brand').shares.map((s) => s.name), ['Brand Assets'])
  t.is(filterSpace({ files, shares }, 'brand').matched, 0, 'a folder match is not a file match')
})
