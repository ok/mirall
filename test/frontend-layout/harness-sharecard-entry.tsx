// Real-Chromium hit-area harness for the folder card. Mounts the REAL <ShareCard>
// and asserts the nav button is full-bleed and that a click anywhere in the card
// body — padding strips, folder icon, owner avatar — resolves to the nav button
// (the whole card navigates), while the action buttons stay clickable on top. A
// second mount checks `isolate` confines the action cluster's z-10 so an earlier
// sibling at z-10 (the sticky section header) paints over the card.
import { createRoot } from 'react-dom/client'
import i18n from './../../src/renderer/i18n.js'
import ShareCard from './../../src/renderer/components/cards/ShareCard.js'
import type { ShareWithRole } from './../../src/renderer/hooks/useShares.js'
import type { Profile } from './../../src/renderer/types.js'

interface HarnessResults {
  pass: boolean
  error: string | null
  navInsetTop: number
  fullBleed: boolean
  hitIcon: boolean
  hitAvatar: boolean
  bodySamples: number
  bodyMisses: number
  moreReachable: boolean
  chevronReachable: boolean
  headerStackTested: boolean
  headerWins: boolean
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const share: ShareWithRole = {
  id: 'share1',
  type: 'owned-folder',
  name: 'Photos',
  owner: 'ownerkey',
  spaceId: 'space1',
  createdAt: 0,
  role: 'mine',
  mountStatus: 'ok',
  mirrorEnabled: true,
}

const selfProfile: Profile = { displayName: 'Me', avatar: null, publicKey: 'selfkey' }

const cardEl = (
  <ShareCard
    share={share}
    owner={null}
    selfProfile={selfProfile}
    fileCount={3}
    totalBytes={4096}
    onOpen={() => {}}
    onOpenInFinder={() => {}}
    onDelete={() => {}}
  />
)

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-8 space-y-8">
    <div id="card-host" className="max-w-3xl">{cardEl}</div>
    <div id="stack-host" className="relative max-w-3xl">
      <div id="stack-header" className="absolute inset-x-0 top-0 h-full z-10 bg-surface" />
      {cardEl}
    </div>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function centre(el: Element): [number, number] {
  const r = el.getBoundingClientRect()
  return [r.left + r.width / 2, r.top + r.height / 2]
}

function owns(target: Element, x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y)
  return !!el && (el === target || target.contains(el))
}

function rectContains(r: DOMRect, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

function publishError(error: string): void {
  window.__results = {
    pass: false,
    error,
    navInsetTop: -1,
    fullBleed: false,
    hitIcon: false,
    hitAvatar: false,
    bodySamples: 0,
    bodyMisses: -1,
    moreReachable: false,
    chevronReachable: false,
    headerStackTested: false,
    headerWins: false,
  }
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  let host: HTMLElement | null = null
  let card: Element | null = null
  while (!card && Date.now() < deadline) {
    await sleep(50)
    host = document.getElementById('card-host')
    card = host?.firstElementChild ?? null
  }
  if (!host || !card) return publishError('ShareCard never mounted')

  const navBtn = host.querySelector<HTMLButtonElement>('button[aria-label^="Open "]')
  const moreBtn = host.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('share.moreActions')}"]`)
  const chevronBtn = host.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('share.browseFiles')}"]`)
  if (!navBtn) return publishError('nav (Open) button not found')
  if (!moreBtn) return publishError('More-actions button not found')
  if (!chevronBtn) return publishError('chevron (browse) button not found')

  // content wrapper (sibling after the overlay) → icon wrapper (its first child) →
  // owner avatar (the first absolutely-positioned descendant of the icon wrapper).
  const iconWrapper = navBtn.nextElementSibling?.firstElementChild ?? null
  const avatarEl = iconWrapper?.querySelector('.absolute') ?? null
  if (!iconWrapper || !avatarEl) return publishError('icon wrapper / avatar not found')

  const cardRect = card.getBoundingClientRect()
  const navRect = navBtn.getBoundingClientRect()
  const clusterRect = (chevronBtn.parentElement ?? chevronBtn).getBoundingClientRect()

  const navInsetTop = Math.round(navRect.top - cardRect.top)
  const fullBleed =
    Math.abs(navRect.top - cardRect.top) < 1.5 &&
    Math.abs(navRect.left - cardRect.left) < 1.5 &&
    Math.abs(navRect.right - cardRect.right) < 1.5 &&
    Math.abs(navRect.bottom - cardRect.bottom) < 1.5

  // Positioned descendants (icon tile, avatar) used to paint over the source-first
  // overlay and intercept clicks — the regression this harness now guards.
  const [ix, iy] = centre(iconWrapper)
  const [ax, ay] = centre(avatarEl)
  const hitIcon = owns(navBtn, ix, iy)
  const hitAvatar = owns(navBtn, ax, ay)

  // Sweep the whole card; every point outside the action cluster must navigate.
  const cols = 9
  const rows = 3
  let bodySamples = 0
  let bodyMisses = 0
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = cardRect.left + ((i + 0.5) / cols) * cardRect.width
      const y = cardRect.top + ((j + 0.5) / rows) * cardRect.height
      if (rectContains(clusterRect, x, y)) continue
      bodySamples++
      if (!owns(navBtn, x, y)) bodyMisses++
    }
  }

  const [mx, my] = centre(moreBtn)
  const [cx, cy] = centre(chevronBtn)
  const moreReachable = owns(moreBtn, mx, my)
  const chevronReachable = owns(chevronBtn, cx, cy)

  // Stacking: an earlier z-10 sibling (mock sticky header) must paint over the
  // whole card, including its z-10 action cluster — true only if `isolate`
  // confines the cluster to the card's own stacking context.
  const stackHost = document.getElementById('stack-host')
  const header = document.getElementById('stack-header')
  const stackChevron = stackHost?.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('share.browseFiles')}"]`) ?? null
  let headerStackTested = false
  let headerWins = false
  if (stackHost && header && stackChevron) {
    const [hx, hy] = centre(stackChevron)
    headerStackTested = rectContains(header.getBoundingClientRect(), hx, hy)
    if (headerStackTested) headerWins = owns(header, hx, hy)
  }

  window.__results = {
    pass:
      fullBleed && hitIcon && hitAvatar && bodyMisses === 0 &&
      moreReachable && chevronReachable && headerStackTested && headerWins,
    error: null,
    navInsetTop,
    fullBleed,
    hitIcon,
    hitAvatar,
    bodySamples,
    bodyMisses,
    moreReachable,
    chevronReachable,
    headerStackTested,
    headerWins,
  }
}

run()
