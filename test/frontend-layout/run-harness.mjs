// Shared driver for the frontend-layout harnesses (LOCAL/dev-machine only — spawns a
// real Electron GUI process). (Re)builds the bundles unless --no-build, spawns the
// Electron host on the given harness HTML, parses the __HARNESS__…__END__ sentinel from
// stdout, and returns the result object. Each run-*.mjs keeps its own console formatting
// and pass/exit logic.
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '../..')

export async function runHarness ({ html, height, width } = {}) {
  if (!process.argv.slice(2).includes('--no-build')) {
    execFileSync('node', [path.join(HERE, 'build.mjs')], { cwd: REPO, stdio: 'inherit' })
  }
  const electron = path.join(REPO, 'node_modules/.bin/electron')
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  if (html != null) env.HARNESS_HTML = html
  if (height != null) env.HARNESS_H = String(height)
  if (width != null) env.HARNESS_W = String(width)
  const out = await new Promise((resolve, reject) => {
    let buf = ''
    const proc = spawn(electron, [path.join(HERE, 'electron-main.cjs')], { cwd: REPO, env })
    proc.stdout.on('data', (d) => { buf += d.toString() })
    proc.stderr.on('data', (d) => process.stderr.write(d))
    proc.on('error', reject)
    proc.on('close', () => {
      const m = buf.match(/__HARNESS__(.*)__END__/)
      if (!m) return reject(new Error('no harness result on stdout:\n' + buf.slice(-500)))
      resolve(JSON.parse(m[1]))
    })
  })
  if (out.error) {
    console.error('\nHARNESS ERROR:', out.error)
    process.exit(2)
  }
  return out
}
