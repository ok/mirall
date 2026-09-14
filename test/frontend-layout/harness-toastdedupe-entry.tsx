// REGRESSION harness for retry error toasts (issue #248). Mounts the REAL <ToastProvider> and
// says the same sentence three times, as a user retrying a failing action does. Asserts (1) one
// banner, not three, (2) the repeat REMOUNTS its toast — a reused instance keeps the countdown
// refs it was mounted with, so the ring would carry the first attempt's elapsed time and the
// role="alert" node would not be re-announced — (3) the ring restarts from full, and (4) a
// DIFFERENT sentence still stacks beside it.
import './harness-bootstrap.js'
import './../../src/renderer/i18n.js'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider, useToast } from './../../src/renderer/components/toast/ToastProvider.js'
import type { ToastApi } from './../../src/renderer/components/toast/types.js'

const RETRY_MESSAGE = 'Something went wrong. Try again.'
const OTHER_MESSAGE = 'The folder is no longer reachable.'

interface HarnessResults {
  pass: boolean
  error: string | null
  afterThreeRetries: number
  remounted: boolean
  ringBeforeRetry: number
  ringAfterRetry: number
  afterOtherMessage: number
}

declare global {
  interface Window {
    __results: HarnessResults
    __toastApi: ToastApi
  }
}

function ToastHandle() {
  const toast = useToast()
  useEffect(() => {
    window.__toastApi = toast
  }, [toast])
  return null
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <ToastProvider>
    <ToastHandle />
  </ToastProvider>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publishError(error: string): void {
  window.__results = {
    pass: false,
    error,
    afterThreeRetries: -1,
    remounted: false,
    ringBeforeRetry: -1,
    ringAfterRetry: -1,
    afterOtherMessage: -1,
  }
}

const toasts = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="region"] > div'))

// The countdown ring is the second circle of the dismiss button's svg: its dash offset runs from
// the full circumference (nothing elapsed) down to 0.
function ringOffset(toast: HTMLElement): number {
  const circles = toast.querySelectorAll('circle')
  const ring = circles[1]
  return ring ? parseFloat(ring.getAttribute('stroke-dashoffset') ?? '-1') : -1
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  while (!window.__toastApi && Date.now() < deadline) await sleep(50)
  if (!window.__toastApi) return publishError('the toast api never reached the harness')
  const toast = window.__toastApi

  // The failing action, retried. Each attempt is a separate user click, well apart in time.
  toast.error(RETRY_MESSAGE)
  await sleep(400)
  toast.error(RETRY_MESSAGE)
  await sleep(1200)

  const beforeRetry = toasts()
  if (beforeRetry.length !== 1) return publishError('expected 1 toast before the third retry, got ' + beforeRetry.length)
  const nodeBeforeRetry = beforeRetry[0]
  const ringBeforeRetry = ringOffset(nodeBeforeRetry)

  toast.error(RETRY_MESSAGE)
  await sleep(150)

  const afterRetry = toasts()
  const afterThreeRetries = afterRetry.length
  const remounted = afterRetry.length === 1 && afterRetry[0] !== nodeBeforeRetry
  const ringAfterRetry = afterRetry.length === 1 ? ringOffset(afterRetry[0]) : -1

  toast.error(OTHER_MESSAGE)
  await sleep(150)
  const afterOtherMessage = toasts().length

  window.__results = {
    pass:
      afterThreeRetries === 1 &&
      remounted &&
      ringBeforeRetry > 0 &&
      ringAfterRetry > ringBeforeRetry &&
      afterOtherMessage === 2,
    error: null,
    afterThreeRetries,
    remounted,
    ringBeforeRetry,
    ringAfterRetry,
    afterOtherMessage,
  }
}

run()
