// Turns a pass-on-retry from an annotation nobody counts into a countable, attributable fact with a
// budget over it.
//
// The flow shards retry a failed file once and go green if the retry passes. That is the right call
// for a real 6-shard P2P suite on a 2-vCPU runner — verified-known flakiness exists independently
// of any diff, so failing on the first flake would turn CI into a re-run lottery. What was wrong is
// that the only trace was a `::warning`: annotation-only, nothing aggregates it, so "is this suite
// getting flakier" was unanswerable and the failed attempt's output — which the warning text itself
// pointed at — was thrown away.
//
// Honest limit: this measures ONE run. A file that flakes 30% of the time passes a maxTotal of 1
// most runs. It makes flakes countable and attributable, which is the precondition for a cross-run
// rate; it is not itself a rate.
import { readFileSync, readdirSync, existsSync } from 'fs'
import path from 'path'

// Two rules, and they have to agree with each other. `maxTotal` is the aggregate ceiling for one
// run and is the gate: exceed it and the ledger is red. `perFile` names the files KNOWN to flake,
// each with its own cap and reason, so a repeat offender cannot hide inside the aggregate. A file
// absent from `perFile` is not forbidden from flaking — it is reported by name so it becomes a
// candidate for the table — because a per-file budget of zero plus an aggregate budget of one
// contradict each other, and the contradiction would resolve as "red on arrival", which is exactly
// what trains people to re-run instead of look.
export function evaluateLedger (reports, budget) {
  const flaked = []
  for (const report of reports) {
    for (const entry of report.files || []) {
      if (entry.passedOnRetry) flaked.push({ shard: report.shard, file: entry.file, attempts: entry.attempts })
    }
  }

  const perFile = budget.perFile || {}
  const counts = new Map()
  for (const { file } of flaked) counts.set(file, (counts.get(file) || 0) + 1)

  const unbudgeted = [...counts.keys()].filter((file) => !(file in perFile)).sort()
  const over = [...counts.entries()].filter(([file, n]) => file in perFile && n > perFile[file].max)
    .map(([file, n]) => `${file} flaked ${n}x, budget ${perFile[file].max}`).sort()
  const total = flaked.length
  const overTotal = total > budget.maxTotal

  return { ok: !overTotal && over.length === 0, total, maxTotal: budget.maxTotal, flaked, unbudgeted, over, overTotal }
}

export function describeLedger (verdict) {
  const lines = [`Flow flakes this run: ${verdict.total} (budget ${verdict.maxTotal})`]
  for (const f of verdict.flaked) lines.push(`  shard ${f.shard}: ${f.file} passed on attempt ${f.attempts}`)
  if (verdict.overTotal) lines.push(`FAIL: ${verdict.total} pass-on-retry exceeds the budget of ${verdict.maxTotal}`)
  for (const file of verdict.unbudgeted) lines.push(`NEW: ${file} flaked and is not named in test/flow-flake-budget.json`)
  for (const line of verdict.over) lines.push(`FAIL: ${line}`)
  if (verdict.ok && verdict.total === 0) lines.push('No retries. The suite passed on first attempt everywhere.')
  return lines.join('\n')
}

export function readReports (dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => /^flake-\d+\.json$/.test(n))
    .map((n) => JSON.parse(readFileSync(path.join(dir, n), 'utf8')))
}

if (process.argv[1] && process.argv[1].endsWith('flake-ledger.mjs')) {
  const [dir = 'flake-reports', budgetPath = 'test/flow-flake-budget.json'] = process.argv.slice(2)
  const reports = readReports(dir)
  const verdict = evaluateLedger(reports, JSON.parse(readFileSync(budgetPath, 'utf8')))
  const text = describeLedger(verdict)
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('fs')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Flow flake ledger\n\n\`\`\`\n${text}\n\`\`\`\n`)
  }
  if (!verdict.ok) process.exit(1)
}
