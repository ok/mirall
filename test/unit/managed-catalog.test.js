import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import vectors from '../fixtures/managed/bundle-v1.json' with { type: 'json' }
import { acceptValue, CATALOG_KEYS, DEFERRED, KNOWN_SETTINGS } from '../../src/shared/managed/catalog.js'
import { MANAGED_SETTING_KEYS } from '../../src/shared/contract/managed-settings.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)))

test('the catalog is a byte copy of the Console fixture', (t) => {
  t.ok(read('../../src/shared/managed/catalog.v1.json').equals(read('../fixtures/managed/catalog.v1.json')))
})

test('the contract key list is the catalog', (t) => {
  t.alike([...MANAGED_SETTING_KEYS].sort(), [...CATALOG_KEYS].sort())
})

test('every key is known to this build or deferred, never both', (t) => {
  for (const key of CATALOG_KEYS) t.ok(KNOWN_SETTINGS.has(key) !== (key in DEFERRED), key)
})

test('acceptValue', (t) => {
  const relayKey = 'yryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyo'
  const cases = [
    ['network.relayMode', ['off', 'auto', 'always'], ['ALWAYS', 1, null]],
    ['network.relayKey', [relayKey], [relayKey.slice(1), 'not-a-relay-key', 7]],
    ['audit.enabled', [true], [false, 'true']],
    ['audit.retentionDays', [30, 90, 365], [120, 29, 366, 90.5, '90']],
    ['backup.folder.macos', ['/Volumes/mirall/{user}/{host}-{install}'], ['/x', '/{install}', 3]],
    ['backup.folder.windows', ['\\\\nas\\mirall\\{user}\\{host}-{install}'], ['C:/backup/{install}']],
    ['backup.required', [true], [false]],
    ['audit.forwardingEnabled', [], [true]],
    ['not.a.key', [], [true]],
  ]
  for (const [key, good, bad] of cases) {
    for (const v of good) t.ok(acceptValue(key, v), `${key} accepts ${JSON.stringify(v)}`)
    for (const v of bad) t.absent(acceptValue(key, v), `${key} refuses ${JSON.stringify(v)}`)
  }
})

test('the vectors\' appRefuses are exactly what acceptValue refuses', (t) => {
  for (const p of vectors.positives) {
    const refused = Object.entries(p.settings).filter(([key, s]) => s.locked && !acceptValue(key, s.value)).map(([key]) => key).sort()
    t.alike(refused, [...(p.appRefuses ?? [])].sort(), p.name)
  }
})
