import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { tmpDir } from '../helpers/bare-tmp.js'
import { loadFeatureFlags } from '../../src/shared/core/feature-flags.js'

function root(t, body) {
  const dir = tmpDir('flags', t)
  if (body !== undefined) fs.writeFileSync(path.join(dir, 'feature-flags.json'), body)
  return dir
}

function quiet() {
  const warnings = []
  return { warnings, log: { warn: (...args) => warnings.push(args.join(' ')) } }
}

test('the shipped file is read from the package root', (t) => {
  const { warnings, log } = quiet()
  t.alike(loadFeatureFlags(root(t, JSON.stringify({ topicRefs: true, membershipControlBinding: false })), { log }),
    { topicRefs: true, membershipControlBinding: false })
  t.alike(warnings, [])
})

test('a missing or malformed file reverts to defaults, and says so', (t) => {
  const missing = quiet()
  t.alike(loadFeatureFlags(root(t), { log: missing.log }), {})
  t.is(missing.warnings.length, 1, 'a missing file is warned about')
  const broken = quiet()
  t.alike(loadFeatureFlags(root(t, '{not json'), { log: broken.log }), {})
  t.is(broken.warnings.length, 1)
  const notObject = quiet()
  t.alike(loadFeatureFlags(root(t, '[true]'), { log: notObject.log }), {})
  t.is(notObject.warnings.length, 1)
})

test('a host override merges over the file', (t) => {
  const { log } = quiet()
  const dir = root(t, JSON.stringify({ topicRefs: false, membershipControlBinding: true }))
  t.alike(loadFeatureFlags(dir, { override: { topicRefs: true }, log }), { topicRefs: true, membershipControlBinding: true })
  t.alike(loadFeatureFlags(dir, { override: 'nope', log }), { topicRefs: false, membershipControlBinding: true }, 'a non-object override is ignored')
})

test('the repo root is a package root the worker can read', (t) => {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const flags = loadFeatureFlags(path.resolve(here, '..', '..'), { log: quiet().log })
  t.ok('topicRefs' in flags && 'membershipControlBinding' in flags, 'both staged flags are declared')
})
