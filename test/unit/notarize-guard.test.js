import test from 'brittle'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const CONFIG = require.resolve('../../forge.config.js')

const SIGNING = 'Developer ID Application: Example (ABCDE12345)'
const CREDS = {
  APPLE_ID: 'dev@example.com',
  APPLE_ID_PASSWORD: 'abcd-efgh-ijkl-mnop',
  APPLE_TEAM_ID: 'ABCDE12345',
}

// forge.config.js reads APPLE_* at module scope but UPGRADE_KEY inside the hook,
// so the env has to stay swapped in across both the load and the hook call. Env
// is replaced wholesale rather than merged, to keep a real APPLE_* in the
// developer's shell from leaking in and flipping a case.
async function withEnv(env, fn) {
  const saved = process.env
  process.env = { UPGRADE_KEY: 'pear://test', ...env }
  try {
    delete require.cache[CONFIG]
    return await fn(require(CONFIG))
  } finally {
    process.env = saved
    delete require.cache[CONFIG]
  }
}

const loadConfig = (env) => withEnv(env, (cfg) => cfg)
const prePackage = (env, platform = 'darwin') =>
  withEnv(env, (cfg) => cfg.hooks.prePackage({}, platform, 'arm64'))
const failureOf = (env, platform) =>
  prePackage(env, platform).then(() => null, (err) => err)
const afterCopy = (env, buildPath) =>
  withEnv(env, (cfg) => new Promise((resolve, reject) => {
    cfg.packagerConfig.afterCopy[0](buildPath, '', 'linux', 'x64', (err) => (err ? reject(err) : resolve()))
  }))

test('signing identity plus full credentials arms notarization', async (t) => {
  const cfg = await loadConfig({ APPLE_SIGNING_IDENTITY: SIGNING, ...CREDS })
  t.alike(
    cfg.packagerConfig.osxNotarize,
    { appleId: CREDS.APPLE_ID, appleIdPassword: CREDS.APPLE_ID_PASSWORD, teamId: CREDS.APPLE_TEAM_ID },
    'osxNotarize wired from env'
  )
  await t.execution(prePackage({ APPLE_SIGNING_IDENTITY: SIGNING, ...CREDS }), 'guard passes')
})

// REGRESSION (FIX-1): APPLE_TEAM_ID was unset in CI, so osxNotarize was never
// set and every macOS build shipped signed-but-unnotarized while passing green.
for (const missing of Object.keys(CREDS)) {
  test(`signing with ${missing} unset fails the build instead of skipping notarization`, async (t) => {
    const env = { APPLE_SIGNING_IDENTITY: SIGNING, ...CREDS }
    delete env[missing]

    const cfg = await loadConfig(env)
    t.absent(cfg.packagerConfig.osxNotarize, 'notarization cannot arm without the full set')

    const err = await failureOf(env)
    t.ok(err, 'build fails')
    t.ok(/notarization is not/.test(err.message), 'error explains the downgrade')
    t.ok(err.message.includes(missing), 'error names the missing credential')
  })
}

test('signing with no credentials at all fails, naming all three', async (t) => {
  const err = await failureOf({ APPLE_SIGNING_IDENTITY: SIGNING })
  t.ok(err, 'build fails')
  for (const name of Object.keys(CREDS)) {
    t.ok(err.message.includes(name), `error names ${name}`)
  }
})

test('ALLOW_UNNOTARIZED opts a local build out of the guard', async (t) => {
  await t.execution(
    prePackage({ APPLE_SIGNING_IDENTITY: SIGNING, ALLOW_UNNOTARIZED: '1' }),
    'explicit opt-out is honoured'
  )
})

test('guard is scoped to signed darwin builds', async (t) => {
  // Unsigned build: nothing to notarize, so nothing to enforce.
  await t.execution(prePackage({}), 'no signing identity, no guard')
  // A signing identity exported in the shell must not break other platforms.
  await t.execution(prePackage({ APPLE_SIGNING_IDENTITY: SIGNING }, 'linux'), 'linux unaffected')
  await t.execution(prePackage({ APPLE_SIGNING_IDENTITY: SIGNING }, 'win32'), 'win32 unaffected')
})

test('UPGRADE_KEY check still fires first', async (t) => {
  const err = await failureOf({ UPGRADE_KEY: '', APPLE_SIGNING_IDENTITY: SIGNING })
  t.ok(err, 'build fails')
  t.ok(/UPGRADE_KEY/.test(err.message), 'existing fail-fast intact and takes precedence')
  t.ok(/UPGRADE_KEY=none/.test(err.message), 'error points at the keyless escape hatch')
})

// Building from source without a Pear channel key. A made-up link can't stand in
// (pear-runtime-updater decodes the key in its constructor and throws), so the
// packager has to ship package.json with no `upgrade` field at all — that is what
// main.js's updater-less shim path expects.
test('UPGRADE_KEY=none packages with no OTA channel', async (t) => {
  await t.execution(prePackage({ UPGRADE_KEY: 'none' }), 'pre-flight allows the keyless build')

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirall-forge-'))
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'mirall' }))

  await afterCopy({ UPGRADE_KEY: 'none' }, dir)
  const staged = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))
  t.absent('upgrade' in staged, 'no upgrade field is injected')
})

test('a real UPGRADE_KEY is still injected into the staged package.json', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirall-forge-'))
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'mirall' }))

  await afterCopy({ UPGRADE_KEY: 'pear://test' }, dir)
  const staged = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))
  t.is(staged.upgrade, 'pear://test', 'release path unchanged')
})
