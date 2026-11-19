import test from 'brittle'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, '..', 'fixtures', 'thread-start', 'main.mjs')
// The Bare the worker runs on in a release: the binary baked into bare-sidecar, which is not the
// bare-runtime that test:bare uses and can be a different version.
const sidecarRoot = path.dirname(createRequire(import.meta.url).resolve('bare-sidecar'))
const shippedBare = path.join(sidecarRoot, 'prebuilds', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'bare.exe' : 'bare')

function runOnShippedBare(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(shippedBare, [entry], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

test('a thread that loads a native addon starts on the shipped Bare', async (t) => {
  const run = await runOnShippedBare(fixture)
  t.is(run.code, 0, `exit ${run.code ?? run.signal}: ${run.stderr.split('\n')[0]}`)
  if (run.code !== 0) return
  const result = JSON.parse(run.stdout)
  t.is(result.threadHash.length, 64, 'the thread answered over the channel with a hash')
  t.is(result.threadHash, result.mainHash, 'the thread read the shared block and hashed it as the worker does')
})
