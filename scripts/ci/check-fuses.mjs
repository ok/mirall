// Asserts the Electron fuses on a packaged binary, the artifact rather than forge.config.js: the
// packaged app must refuse to run as a generic Node and load only its own integrity-checked asar.
//   node scripts/ci/check-fuses.mjs <path to Mirall.app | Mirall.exe | Mirall>
import fuses from '@electron/fuses'

const { getCurrentFuseWire, FuseV1Options } = fuses

// The wire stores each fuse as an ASCII byte: '0' off, '1' on. The package does not export these.
const OFF = '0'.charCodeAt(0)
const ON = '1'.charCodeAt(0)

const EXPECTED = {
  RunAsNode: OFF,
  EnableNodeOptionsEnvironmentVariable: OFF,
  EnableNodeCliInspectArguments: OFF,
  EnableEmbeddedAsarIntegrityValidation: ON,
  OnlyLoadAppFromAsar: ON,
}

const target = process.argv[2]
if (!target) {
  console.error('usage: check-fuses.mjs <path to Mirall.app | Mirall.exe | Mirall>')
  process.exit(2)
}

const wire = await getCurrentFuseWire(target)
const label = (state) => (state === undefined ? 'absent' : String.fromCharCode(state))
const wrong = Object.entries(EXPECTED).filter(([name, state]) => wire[FuseV1Options[name]] !== state)
for (const [name, state] of wrong) {
  console.error(`fuse ${name}: expected ${label(state)}, got ${label(wire[FuseV1Options[name]])}`)
}
if (wrong.length) process.exit(1)
console.log('fuses ok:', target)
