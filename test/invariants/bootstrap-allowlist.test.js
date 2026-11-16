import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { MOVED_GROUPS } from '../../src/shared/contract/settings-file.js'
import { defaultSettings, settingsToRuntimeConfig } from '../../src/shared/core/settings-rules.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', '..', 'src', 'main', 'worker-host.js'), 'utf8')

// The bootstrap frame carries what only the host knows: the packaged app's facts and the MIRALL_*
// levers. No secret rides it — the identity key and the relay seed go to the worker over a socket
// connection once it listens. A preference or a flag on it would win over the worker's own files, so
// the key set is pinned here, and the keys the moved settings groups project onto are refused.
const HOST_FACTS = ['type', 'storage', 'appVersion', 'upgradeKey', 'dev', 'verbose', 'identityWeak', 'defaultDownloadFolder']
const NEVER_ON_THE_BOOTSTRAP = ['identityKEK', 'relaySeed']
const LEVERS = [
  'downloadFolder', 'featureFlags', 'dhtBootstrap', 'listFilesCap', 'testTruncatePeerDrainAfter',
  'maxFilesPerShare', 'deriveDebounceMs', 'freeUpMinBytes', 'foreignFullWalkEvery', 'listFullReadEvery',
  'managedTestSigningKey', 'managedAllowHttpLoopback', 'managedPreviewTimeoutMs', 'managedDriveGraceMs', 'managedHttpsPollMs', 'managedReportDelayMs',
]

function bootstrapKeys() {
  const start = source.indexOf('const bootstrap = {')
  const end = source.indexOf('\n  }\n', start)
  const body = source.slice(start, end)
  return [...body.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1])
}

test('the bootstrap literal carries host facts and levers only', (t) => {
  t.alike(bootstrapKeys().sort(), [...HOST_FACTS, ...LEVERS].sort())
})

test('no secret may ride the bootstrap', (t) => {
  const keys = new Set(bootstrapKeys())
  for (const key of NEVER_ON_THE_BOOTSTRAP) t.absent(keys.has(key), key + ' goes over the socket, not the spawn pipe')
})

test('no key a moved settings group projects onto rides the bootstrap', (t) => {
  const keys = new Set(bootstrapKeys())
  const projected = Object.keys(settingsToRuntimeConfig(defaultSettings())).filter((k) => k !== 'downloadFolder')
  for (const key of projected) t.absent(keys.has(key), key + ' is the worker\'s')
  for (const group of MOVED_GROUPS) t.absent(source.includes("config().get('" + group), 'main no longer reads ' + group)
})
