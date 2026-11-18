// How long a periodic background job took, reported to whoever is listening. A job that holds the
// worker thread stalls every transfer for as long as it runs, and the loop lag a transfer trace
// records says only that something did; a job reported here at the same moment says which. With no
// observer installed, which is every run without a test run file, timedJob runs the job and
// nothing else.

// Shorter than this a job cannot account for a stall worth explaining.
const SLOW_JOB_MS = 50

let observer = null

/** @param {((job: string, ms: number) => void) | null} next */
export function setJobObserver(next) {
  observer = next
}

/**
 * Runs `run` and, when it took long, reports its name and its duration from start to settlement.
 * The result, a thrown error and a rejection all pass through unchanged.
 * @template T
 * @param {string} job
 * @param {() => T} run
 * @returns {T}
 */
export function timedJob(job, run) {
  if (!observer) return run()
  const started = Date.now()
  const report = () => {
    const ms = Date.now() - started
    if (ms < SLOW_JOB_MS) return
    try { observer?.(job, ms) } catch {}
  }
  let result
  try {
    result = run()
  } catch (err) {
    report()
    throw err
  }
  if (typeof result?.then !== 'function') {
    report()
    return result
  }
  return result.then((value) => { report(); return value }, (err) => { report(); throw err })
}
