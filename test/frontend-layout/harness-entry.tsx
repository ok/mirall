// Real-Chromium layout harness. Mounts the REAL <FolderView> inside the REAL
// app-shell wrappers (root `min-h-screen` + `<main>` top-padding that, together
// with the screen's `h-[calc(100vh-5rem-var(--banner-h))]`, sum to exactly
// 100vh), then reproduces the mirror-download re-render storm and measures
// whether the DOCUMENT (not the inner list) ever overflows the viewport.
//
// `window.bridge` is installed by fake-bridge.js (a classic script loaded first
// in harness.html), so `ipc.ts` and every hook/component run unmodified.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import FolderView from './../../src/renderer/screens/FolderView.js'
import { offenders, positioned, bodyChildren, containerMetrics, documentScrollable } from './document-overflow.js'

const f = (window as unknown as { __fake: { SPACE_ID: string; SHARE_ID: string; OWNER_PK: string; files: Array<{ relPath: string; size: number }> } }).__fake
const emit = (window as unknown as { __fakeEmit: (o: Record<string, unknown>) => void }).__fakeEmit

const share = {
  id: f.SHARE_ID,
  type: 'owned-folder',
  name: '[CLV009] - Vhinz - Belvedere Flac',
  owner: f.OWNER_PK,
  spaceId: f.SPACE_ID,
  createdAt: 0,
  role: 'mirrored',
} as unknown as Parameters<typeof FolderView>[0]['share']

const container = document.getElementById('root') as HTMLElement
createRoot(container).render(
  <div className="min-h-screen bg-surface">
    <main className="pt-[calc(5rem+var(--banner-h,0px))]">
      <ToastProvider>
        <FolderView spaceId={f.SPACE_ID} share={share} onBack={() => {}} />
      </ToastProvider>
    </main>
  </div>,
)

// --- measurement -----------------------------------------------------------

function fileRowCount(): number {
  return document.querySelectorAll('p.truncate').length
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function run() {
  // Wait for the list to populate (list-files round-trip + render).
  const deadline = Date.now() + 6000
  while (fileRowCount() < 20 && Date.now() < deadline) await sleep(50)
  await sleep(150)

  const ih0 = window.innerHeight
  const baselineOverflow = document.documentElement.scrollHeight - ih0
  const baselineOffenders = offenders(ih0)

  const active = f.files.slice(0, 6)
  const totals = active.map((x) => x.size)
  const bytes = active.map(() => 0)

  let maxOverflow = baselineOverflow
  let worst = baselineOffenders
  let worstMetrics = containerMetrics()
  let worstPositioned = positioned()
  let worstBodyChildren = bodyChildren()
  let overflowFrames = 0
  let scrollableFrames = 0
  let everScrollable = documentScrollable()
  let frames = 0

  const start = Date.now()
  await new Promise<void>((resolve) => {
    const id = setInterval(() => {
      frames++
      // Per-chunk progress for the active transfers (fixture rows 1-6 report status
      // 'downloading', so these frames pass the renderer's status gate and paint), on the
      // unified decoration channel keyed shareId:relPath — the per-frame re-render storm.
      for (let i = 0; i < active.length; i++) {
        bytes[i] = Math.min(totals[i], bytes[i] + totals[i] * 0.03)
        if (bytes[i] >= totals[i]) bytes[i] = 0
        emit({
          type: 'event:decoration', channel: 'transfer',
          spaceId: f.SPACE_ID, key: `${f.SHARE_ID}:${active[i].relPath}`,
          bytes: bytes[i], total: totals[i], speed: 1_000_000,
        })
      }
      // Periodic full refresh (a sibling file "completing"): rebuilds the whole
      // list and clears `progress` from every row — the churn under suspicion.
      if (frames % 18 === 0) emit({ type: 'event:reconcile', scope: { kind: 'share-files', spaceId: f.SPACE_ID, shareId: f.SHARE_ID } })

      // Measure (reading scrollHeight forces a synchronous layout flush).
      const ih = window.innerHeight
      const ov = document.documentElement.scrollHeight - ih
      if (ov > 0) overflowFrames++
      if (documentScrollable()) { scrollableFrames++; everScrollable = true }
      if (ov > maxOverflow) { maxOverflow = ov; worst = offenders(ih); worstMetrics = containerMetrics(); worstPositioned = positioned(); worstBodyChildren = bodyChildren() }

      if (Date.now() - start > 2800) {
        clearInterval(id)
        resolve()
      }
    }, 16)
  })

  ;(window as unknown as { __results: unknown }).__results = {
    innerHeight: ih0,
    baselineOverflow,
    baselineOffenders,
    maxOverflow,
    overflowFrames,
    everScrollable,
    scrollableFrames,
    frames,
    lastScrollHeight: document.documentElement.scrollHeight,
    worstOffenders: worst,
    worstMetrics,
    worstPositioned,
    worstBodyChildren,
  }
}

run()
