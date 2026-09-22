// REGRESSION harness for per-file transfer-fault alerts (FIX-447). Mounts the REAL <ToastProvider>
// with the REAL <WorkerToastBridge> and starts the REAL notification dispatcher, then emits one
// event:transfer-error per file of a folder download that hit a full disk. Asserts (1) one toast,
// mounted once — a remount re-announces the role="alert" node per file — (2) one OS notification
// at once and one summary under the SAME id after the burst goes quiet, carrying the file count,
// and (3) another fault or another space still gets its own toast.
import './harness-bootstrap.js'
import '../../src/renderer/platform/i18n.js'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import WorkerToastBridge from '../../src/renderer/components/toast/bridges/WorkerToastBridge.js'
import { startNotifications } from '../../src/renderer/notifications/dispatcher.js'
import type { NotificationSpec } from '../../src/renderer/platform/global.d.js'

const FILES = 12
const QUIET_MS = 3000

interface HarnessResults {
  pass: boolean
  error: string | null
  toastsAfterBurst: number
  toastMounts: number
  otherMounts: number
  notifications: Array<{ id: string; body: string }>
  toastsAfterOthers: number
}

declare global {
  interface Window {
    __results: HarnessResults
    __fakeEmit: (frame: Record<string, unknown>) => void
  }
}

const shown: NotificationSpec[] = []
window.bridge.isWindowFocused = () => Promise.resolve(false)
window.bridge.notify = (spec: NotificationSpec) => {
  shown.push(spec)
  return Promise.resolve()
}
startNotifications({ getMemberName: () => null })

createRoot(document.getElementById('root') as HTMLElement).render(
  <ToastProvider>
    <WorkerToastBridge />
  </ToastProvider>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const toasts = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role="region"] > div'))

function fail(error: string): void {
  window.__results = { pass: false, error, toastsAfterBurst: -1, toastMounts: -1, otherMounts: -1, notifications: [], toastsAfterOthers: -1 }
}

const transferError = (spaceId: string, errorCode: string, i: number) => ({
  type: 'event:transfer-error',
  transferId: `${spaceId}|share1|album/track-${i}.flac`,
  spaceId,
  path: `album/track-${i}.flac`,
  errorCode,
})

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  while (!document.querySelector('[role="region"]') && Date.now() < deadline) await sleep(50)
  const region = document.querySelector('[role="region"]')
  if (!region) return fail('the toast region never rendered')

  let mounts = 0
  new MutationObserver((records) => {
    for (const r of records) mounts += r.addedNodes.length
  }).observe(region, { childList: true })

  for (let i = 0; i < FILES; i++) {
    window.__fakeEmit(transferError('space1', 'TRANSFER_DISK_FULL', i))
    await sleep(50)
  }
  await sleep(QUIET_MS + 500)
  const toastsAfterBurst = toasts().length
  const toastMounts = mounts
  const notifications = shown.map((s) => ({ id: s.id, body: s.body ?? '' }))

  window.__fakeEmit(transferError('space1', 'TRANSFER_CHECKSUM', 0))
  window.__fakeEmit(transferError('space2', 'TRANSFER_DISK_FULL', 0))
  await sleep(300)
  const toastsAfterOthers = toasts().length
  const otherMounts = mounts - toastMounts

  const [leading, summary] = notifications
  window.__results = {
    pass:
      toastsAfterBurst === 1 &&
      toastMounts === 1 &&
      notifications.length === 2 &&
      leading.id === summary.id &&
      summary.body.startsWith(`${FILES} files`) &&
      toastsAfterOthers === 3 &&
      otherMounts === 2,
    error: null,
    toastsAfterBurst,
    toastMounts,
    otherMounts,
    notifications,
    toastsAfterOthers,
  }
}

run()
