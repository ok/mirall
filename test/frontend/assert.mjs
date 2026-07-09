import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed')
}

export function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const fp = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSize(fp)
      else total += statSync(fp).size
    } catch {}
  }
  return total
}

export async function waitFor(fn, timeout = 30000, label = 'condition') {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`timed out waiting for ${label} (${timeout}ms)`)
}

// Each makeReport().summary() records its steps here; run.mjs drains it after
// every scenario to build the aggregate end-of-run summary.
const recordedReports = []
export function drainReports() {
  return recordedReports.splice(0)
}

export function makeReport() {
  const steps = []
  return {
    steps,
    async ok(label, fn) {
      try {
        await fn()
        steps.push({ label, pass: true })
      } catch (e) {
        steps.push({ label, pass: false, err: e.message })
        throw e
      }
    },
    summary() {
      const pass = steps.filter((s) => s.pass).length
      for (const s of steps) console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${s.label}${s.err ? ' -- ' + s.err : ''}`)
      console.log(`\n${pass}/${steps.length} passed`)
      recordedReports.push({ steps: steps.slice() })
      return pass === steps.length
    },
  }
}
