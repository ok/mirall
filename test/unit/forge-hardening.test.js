import test from 'brittle'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { loadConfig } from '../helpers/forge-config.js'

test('REGRESSION (MIR-54: the packaged binary could run as a generic Node): packaged builds flip the fuses', (t) => {
  const fuses = loadConfig().plugins.find((p) => p.name === '@electron-forge/plugin-fuses')
  t.ok(fuses, 'the fuses plugin is configured')
  t.is(fuses?.config.version, FuseVersion.V1)
  t.is(fuses?.config[FuseV1Options.RunAsNode], false)
  t.is(fuses?.config[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false)
  t.is(fuses?.config[FuseV1Options.EnableNodeCliInspectArguments], false)
  t.is(fuses?.config[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true)
  t.is(fuses?.config[FuseV1Options.OnlyLoadAppFromAsar], true)
})
