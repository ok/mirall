// A release build refuses a commit whose tests did not pass. A tag push and a build dispatch start
// no test run of their own, so the build looks the result up: for every required workflow, the
// latest run on the commit being built must have completed with success.
//
// The decision is pure (GitHub API JSON in, verdict out); the CLI at the bottom does the fetching.

// Workflow files whose result a release needs, as named under .github/workflows/.
export const REQUIRED_WORKFLOWS = Object.freeze(['test.yml'])

// Only these runs test the commit itself. A pull_request run carries the PR head's SHA but tests
// its merge into the base, which is a different tree.
const COUNTED_EVENTS = Object.freeze(['push', 'workflow_dispatch'])

export const TEST_STATE = Object.freeze({
  GREEN: 'green',
  MISSING: 'missing',
  RUNNING: 'running',
  FAILED: 'failed',
})

// The run that decides is the one created last. A re-run keeps its run's id and creation time and
// replaces its status and conclusion, so it decides through its current attempt. `head_sha` is
// compared here as well as in the query: a response that ignored the filter must not pass a commit.
export function decidingRun(sha, runs) {
  const counted = runs.filter((run) => run.head_sha === sha && COUNTED_EVENTS.includes(run.event))
  counted.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
  return counted[0] ?? null
}

function workflowResult(sha, workflow, runs) {
  const run = decidingRun(sha, runs)
  if (!run) return { workflow, state: TEST_STATE.MISSING, run: null }
  if (run.status !== 'completed') return { workflow, state: TEST_STATE.RUNNING, run }
  return { workflow, state: run.conclusion === 'success' ? TEST_STATE.GREEN : TEST_STATE.FAILED, run }
}

// `runsByWorkflow` maps a workflow file to the `workflow_runs` array of its runs for `sha`. A
// required workflow absent from the map has no run.
export function releaseTestVerdict(sha, runsByWorkflow, required = REQUIRED_WORKFLOWS) {
  const results = required.map((workflow) => workflowResult(sha, workflow, runsByWorkflow[workflow] ?? []))
  return { ok: results.every((result) => result.state === TEST_STATE.GREEN), sha, results }
}

// One line per required workflow. `ref` is the branch or tag being built, named so the hint for a
// missing run is a command that can be pasted.
export function describeResult(result, { sha, ref }) {
  const { workflow, state, run } = result
  const commit = sha.slice(0, 8)
  switch (state) {
    case TEST_STATE.GREEN:
      return `${workflow} passed for commit ${commit}: ${run.html_url}`
    case TEST_STATE.MISSING:
      return `${workflow} has no run for commit ${commit}. Start one with ` +
        `"gh workflow run ${workflow} --ref ${ref}", wait for it to pass, then re-run this job.`
    case TEST_STATE.RUNNING:
      return `${workflow} is still running for commit ${commit} (${run.status}): ${run.html_url} ` +
        'Wait for it to finish, then re-run this job.'
    default:
      return `${workflow} did not pass for commit ${commit} (${run.conclusion}): ${run.html_url} ` +
        'Re-run its failed jobs until it passes, then re-run this job.'
  }
}

async function fetchRuns({ apiUrl, repository, token, workflow, sha }) {
  const url = `${apiUrl}/repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100`
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!response.ok) throw new Error(`${workflow}: the run lookup answered ${response.status} ${response.statusText}`)
  const body = await response.json()
  if (!Array.isArray(body.workflow_runs)) throw new Error(`${workflow}: the run lookup returned no workflow_runs`)
  // A page that does not hold every run cannot name the latest one.
  if (body.total_count > body.workflow_runs.length) {
    throw new Error(`${workflow}: ${body.total_count} runs for one commit do not fit one page`)
  }
  return body.workflow_runs
}

async function main() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_REF_NAME: ref } = process.env
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com'
  const missing = Object.entries({ GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_REF_NAME: ref })
    .filter(([, value]) => !value).map(([name]) => name)
  if (missing.length > 0) throw new Error(`missing from the environment: ${missing.join(', ')}`)

  const runsByWorkflow = {}
  for (const workflow of REQUIRED_WORKFLOWS) {
    runsByWorkflow[workflow] = await fetchRuns({ apiUrl, repository, token, workflow, sha })
  }
  const verdict = releaseTestVerdict(sha, runsByWorkflow)
  for (const result of verdict.results) {
    const line = describeResult(result, { sha, ref })
    console.log(result.state === TEST_STATE.GREEN ? line : `::error::${line}`)
  }
  if (!verdict.ok) process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('require-green-tests.mjs')) {
  try {
    await main()
  } catch (err) {
    // A lookup that could not be made is not a pass.
    console.log(`::error::The test result for this commit could not be read: ${err.message}`)
    process.exit(1)
  }
}
