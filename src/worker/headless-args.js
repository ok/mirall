// The command line of a back end started without a host, turned into the bootstrap a host would
// have sent on the spawn pipe: the same keys, read by the same assembleRuntimeConfig. What a host
// knows and a command line cannot — the identity KEK and the relay seed — is absent, and the worker
// waits for a client to hand it over (identity:unlock). Pure, so a unit test drives it under Node.
//
// A headless start runs from a source checkout, which the desktop app calls a dev build: `dev` is
// always true, so the release channel is dev. The --dev flag is a separate thing: it admits the test
// levers (a local DHT, flag and runtime-config overrides) that a packaged desktop app refuses.
import { command, flag, bail } from 'paparam'
import { defaultDataDir, joinFor, STORE_DIR } from '../shared/core/default-data-dir.js'

export const USAGE = 'usage: bare src/worker/main.js [--storage <dir>] [--verbose] ' +
  '[--dev [--dht-bootstrap <host:port,...>] [--feature-flags <json>] [--runtime-config <json>]]'

// The keys a runtime-config override may not carry: the store has its own flag, and the secrets
// only ever arrive over the socket.
const NOT_OVERRIDABLE = new Set(['type', 'storage', 'identityKEK', 'relaySeed'])

function parseFlags(argv) {
  let refusal = null
  const cmd = command('mirall-backend',
    bail((b) => { refusal = `${String(b?.reason || 'invalid arguments').toLowerCase()}: ${b?.flag?.name || b?.arg?.value || ''}` }),
    flag('--storage <dir>', 'the data folder (default: the desktop app\'s)'),
    flag('--verbose', 'log at debug level'),
    flag('--dev', 'admit the test levers below'),
    flag('--dht-bootstrap <list>', 'comma-separated host:port DHT bootstrap nodes'),
    flag('--feature-flags <json>', 'feature-flag overrides'),
    flag('--runtime-config <json>', 'runtime-config overrides'),
  )
  const parsed = cmd.parse(argv, { sync: true, silent: true, run: false })
  if (parsed) return { flags: cmd.flags }
  return { refusal: refusal || 'help' }
}

function jsonObject(text, name) {
  let value
  try { value = JSON.parse(text) } catch { return { refusal: `${name} is not JSON` } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { refusal: `${name} is not a JSON object` }
  return { value }
}

function devLevers(flags) {
  const levers = {}
  if (flags.dhtBootstrap) levers.dhtBootstrap = flags.dhtBootstrap.split(',').map((s) => s.trim()).filter(Boolean)
  if (flags.featureFlags) {
    const parsed = jsonObject(flags.featureFlags, '--feature-flags')
    if (parsed.refusal) return parsed
    levers.featureFlags = parsed.value
  }
  if (flags.runtimeConfig) {
    const parsed = jsonObject(flags.runtimeConfig, '--runtime-config')
    if (parsed.refusal) return parsed
    const refused = Object.keys(parsed.value).filter((key) => NOT_OVERRIDABLE.has(key))
    if (refused.length) return { refusal: `--runtime-config may not set ${refused.join(', ')}` }
    Object.assign(levers, parsed.value)
  }
  return { levers }
}

/**
 * @param {{ argv: string[], env: Record<string, string | undefined>, platform: string, homedir: string,
 *   pkg: { version?: string, productName?: string, name?: string } }} input
 * @returns {{ bootstrap: Record<string, unknown> } | { refusal: string }}
 */
export function headlessBootstrap({ argv, env, platform, homedir, pkg }) {
  const { flags, refusal } = parseFlags(argv)
  if (refusal) return { refusal }
  const wantsLevers = flags.dhtBootstrap || flags.featureFlags || flags.runtimeConfig
  if (wantsLevers && !flags.dev) return { refusal: 'test levers need --dev' }
  const { levers, refusal: badLever } = flags.dev ? devLevers(flags) : { levers: {}, refusal: null }
  if (badLever) return { refusal: badLever }
  const dataDir = flags.storage || defaultDataDir({ platform, env, homedir, productName: pkg.productName || pkg.name })
  return {
    bootstrap: {
      storage: joinFor(platform, dataDir, STORE_DIR),
      appVersion: pkg.version || null,
      upgradeKey: null,
      dev: true,
      // The flag, then the environment the desktop app also reads; neither leaves the stored choice.
      verbose: flags.verbose || env.MIRALL_VERBOSE === '1' ? true : undefined,
      // A journal stamps every line it collects; anywhere else the worker's own output is the log.
      logTimestamps: !env.JOURNAL_STREAM,
      ...levers,
    },
  }
}
