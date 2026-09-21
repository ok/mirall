// REGRESSION harness for sticky-toast eviction (issue #373). Mounts the REAL <ToastProvider>, raises
// one sticky toast with an action, then a burst of four auto-dismissing ones. Asserts the sticky toast
// and its action survive as an alert, the oldest auto-dismissing toast made room, and a stack of
// stickies grows past the cap instead of dropping one, keeping the newest notice too, and that a
// stack taller than the window scrolls inside it with the newest toast in view.
import './harness-bootstrap.js'
import '../../src/renderer/platform/i18n.js'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider, useToast } from './../../src/renderer/components/toast/ToastProvider.js'
import type { ToastApi } from './../../src/renderer/components/toast/types.js'

const STICKY_MESSAGE = 'Your request to join Beta was declined'
const STICKY_ACTION = 'Review'
const BURST = ['first.bin', 'second.bin', 'third.bin', 'fourth.bin'].map(
  (name) => `Download stopped — “${name}” was removed by the owner`,
)

interface HarnessResults {
  pass: boolean
  error: string | null
  afterBurst: number
  stickyKept: boolean
  actionKept: boolean
  stickyRole: string
  oldestTimedEvicted: boolean
  afterStickies: number
  newestKept: boolean
  overflowContained: boolean
  newestInView: boolean
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
    afterBurst: -1,
    stickyKept: false,
    actionKept: false,
    stickyRole: '',
    oldestTimedEvicted: false,
    afterStickies: -1,
    newestKept: false,
    overflowContained: false,
    newestInView: false,
  }
}

const toasts = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="region"] > div'))
const toastWith = (text: string): HTMLElement | undefined =>
  toasts().find((el) => el.textContent?.includes(text))

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  while (!window.__toastApi && Date.now() < deadline) await sleep(50)
  if (!window.__toastApi) return publishError('the toast api never reached the harness')
  const toast = window.__toastApi

  toast.error(STICKY_MESSAGE, { duration: 0, action: { label: STICKY_ACTION, onClick: () => {} } })
  await sleep(150)
  for (const message of BURST) toast.info(message, { duration: 8000 })
  await sleep(150)

  const sticky = toastWith(STICKY_MESSAGE)
  const afterBurst = toasts().length
  const stickyKept = sticky !== undefined
  const actionKept =
    !!sticky && Array.from(sticky.querySelectorAll('button')).some((b) => b.textContent === STICKY_ACTION)
  const stickyRole = sticky?.getAttribute('role') ?? ''
  const oldestTimedEvicted = toastWith(BURST[0]) === undefined && BURST.slice(1).every((m) => toastWith(m))

  for (let i = 1; i <= 5; i++) toast.warning(`Sticky notice ${i}`, { id: `sticky-${i}`, duration: 0 })
  toast.info('Newest notice', { duration: 8000 })
  await sleep(150)
  const afterStickies = toasts().length
  const newestKept = toastWith('Newest notice') !== undefined

  for (let i = 6; i <= 25; i++) toast.warning(`Sticky notice ${i}`, { id: `sticky-${i}`, duration: 0 })
  toast.info('Last notice', { duration: 8000 })
  await sleep(300)
  const region = document.querySelector<HTMLElement>('[role="region"]')
  const regionRect = region?.getBoundingClientRect()
  const overflowContained =
    !!region && !!regionRect && regionRect.top >= 0 && region.scrollHeight > region.clientHeight
  const lastRect = toastWith('Last notice')?.getBoundingClientRect()
  const newestInView = !!lastRect && !!regionRect && lastRect.bottom <= regionRect.bottom + 1 && lastRect.top >= regionRect.top

  window.__results = {
    pass:
      afterBurst === 4 &&
      stickyKept &&
      actionKept &&
      stickyRole === 'alert' &&
      oldestTimedEvicted &&
      afterStickies === 7 &&
      newestKept &&
      overflowContained &&
      newestInView,
    error: null,
    afterBurst,
    stickyKept,
    actionKept,
    stickyRole,
    oldestTimedEvicted,
    afterStickies,
    newestKept,
    overflowContained,
    newestInView,
  }
}

run()
