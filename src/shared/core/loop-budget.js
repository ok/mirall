// The worker has one thread, so a loop over every file of a folder holds it for as long as the
// folder is large. A loop budget bounds that by elapsed time, not by a count: what one iteration
// costs differs about tenfold between systems, so a count that is safe on one stalls another.
import { getLoopYieldBudgetMs } from './runtime-config.js'

// Cede the worker's event loop for one turn: pending I/O is polled and due timers run before the
// caller resumes, so IPC and transfer frames are served. An immediate, not a zero timer: a timer's
// wait rounds up to the system's timer tick, which on Windows is longer than the slice it follows.
export const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve))

// One budget per loop, or per run of loops that follow each other without real I/O in between:
//   if (budget.spent()) await budget.cede()
// `spent` is synchronous on purpose — an await on every iteration is itself a cost at folder scale,
// and the caller must see exactly where it gives up the thread: state read before a cede may have
// changed after it, so an abort signal is re-checked there.
export function createLoopBudget({ budgetMs = getLoopYieldBudgetMs(), now = Date.now, cede = yieldToLoop } = {}) {
  let sliceStart = now()
  return {
    spent: () => now() - sliceStart >= budgetMs,
    async cede() {
      await cede()
      sliceStart = now()
    },
  }
}
