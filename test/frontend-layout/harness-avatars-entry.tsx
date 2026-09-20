// Every avatar the app draws, in one tree (LOCAL/dev only — spawns a real Electron GUI process).
// The recess is what makes a face read as the same object on every screen, so it is a property of
// the AVATAR rather than of any one screen: this mounts the primitive in all nine shapes plus the
// real hosts that surround it differently — a member row with a presence dot overlaid, the top bar
// with its status ring, the Activity Log's actor disc (an avatar in everything but the primitive)
// and the first-run picker, which is how an avatar is CHOSEN.
//
// The sweep at the end is the part that catches a screen nobody thought of: every round disc in
// the tree big enough to be an avatar and carrying an image is expected to be recessed, so a new
// hand-rolled one shows up here as a miss rather than as a face that looks subtly different.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import Avatar from './../../src/renderer/components/primitives/Avatar.js'
import MemberCard from './../../src/renderer/components/cards/MemberCard.js'
import TopNav from './../../src/renderer/components/layout/TopNav.js'
import ActivityFeed from './../../src/renderer/components/activity/ActivityFeed.js'
import OnboardingScreen from './../../src/renderer/screens/OnboardingScreen.js'
import { ConnectionStatusProvider } from './../../src/renderer/hooks/useConnectionStatus.js'
import { groupByDay } from './../../src/renderer/model/audit-row.js'
import type { AuditEntry, SpaceMember } from '../../src/renderer/types/types.js'

interface Miss {
  where: string
  size: string
  classes: string
}

interface ProbeResult {
  where: string
  found: boolean
  recessed: boolean
}

interface HarnessResults {
  pass: boolean
  error: string | null
  discsSeen: number
  recessed: number
  probes: ProbeResult[]
  misses: Miss[]
  recessShadow: string
  // The presence dot is positioned against the avatar's box, which the recess wraps in a span for
  // an <img>; if that wrapper changed the box, the dot moves off the disc's corner.
  dotOffsetX: number
  dotOffsetY: number
  dotOnCorner: boolean
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

// A 1x1 PNG is enough: the sweep cares that a disc CARRIES an image, not what is in it.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const MEMBER: SpaceMember = {
  publicKey: 'a'.repeat(64),
  driveKey: 'b'.repeat(64),
  displayName: 'Vhinz Sanchez',
  online: true,
  avatar: PIXEL,
}

const ENTRY: AuditEntry = {
  v: 1,
  seq: 1,
  ts: Date.now(),
  tzOffset: 0,
  kind: 'space.member.joined',
  category: 'membership',
  tier: 'self',
  outcome: 'ok',
  code: null,
  installId: null,
  actor: { type: 'peer', key: 'c'.repeat(64), name: 'Vhinz Sanchez' },
  space: { spaceId: 's'.repeat(64), name: 'Design' },
  target: null,
  subject: null,
  search: '',
}

const noop = () => {}
const noopAsync = async () => {}

createRoot(document.getElementById('root') as HTMLElement).render(
  <ConnectionStatusProvider>
    <div className="p-6 bg-background space-y-6">
      {/* The primitive in every shape it has: image, initials, silhouette × no ring, status ring,
          surface ring. The recess belongs to the disc, so all nine carry it. */}
      <div data-probe="matrix" className="flex items-center gap-3">
        {(['none', 'status', 'surface-container-low'] as const).map((ring) => (
          <div key={ring} className="flex items-center gap-3">
            <Avatar src={PIXEL} displayName="Vhinz Sanchez" size="lg" ring={ring} decorative />
            <Avatar displayName="Vhinz Sanchez" size="lg" ring={ring} decorative />
            <Avatar size="lg" ring={ring} fallback="silhouette" decorative />
          </div>
        ))}
      </div>
      <div data-probe="member" className="bg-surface-container-low rounded-xl p-4">
        <MemberCard member={MEMBER} />
      </div>
      <div data-probe="topnav">
        <TopNav
          profile={{ displayName: 'You', avatar: PIXEL } as never}
          onLogoClick={noop}
          onSettingsClick={noop}
          onAccountClick={noop}
          onFeedbackClick={noop}
          update={null}
          onDismissUpdate={noop}
        />
      </div>
      <div data-probe="activity" className="bg-surface-container-low rounded-xl">
        <ActivityFeed
          groups={groupByDay([ENTRY])}
          entries={[ENTRY]}
          loading={false}
          loadingMore={false}
          error={null}
          hasMore={false}
          loadMore={noopAsync}
          active={false}
          empty={{ key: 'empty', icon: 'history' }}
          onClearFilters={noop}
        />
      </div>
      <div data-probe="onboarding">
        <OnboardingScreen onComplete={noopAsync} />
      </div>
    </div>
  </ConnectionStatusProvider>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publish(results: Partial<HarnessResults>): void {
  window.__results = {
    pass: false,
    error: null,
    discsSeen: 0,
    recessed: 0,
    probes: [],
    misses: [],
    recessShadow: '',
    dotOffsetX: 0,
    dotOffsetY: 0,
    dotOnCorner: false,
    ...results,
  }
}

const isRecessed = (el: Element): boolean => getComputedStyle(el, '::after').boxShadow.includes('inset')

// Where the element sits, for a miss that has to be found in the source afterwards.
function whereOf(el: Element): string {
  const probe = el.closest('[data-probe]')?.getAttribute('data-probe')
  return probe ?? 'unknown'
}

/**
 * Every disc in the tree that is shaped like an avatar: round, at least as big as the smallest
 * avatar size (20px) and either carrying an image or already claiming the recess. A round button
 * or an icon tile carries neither, so it is not swept up.
 */
function avatarDiscs(): Element[] {
  const out: Element[] = []
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const style = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    const round = style.borderRadius.startsWith('9999') || parseFloat(style.borderRadius) >= box.width / 2
    if (!round || box.width < 20 || Math.abs(box.width - box.height) > 1) continue
    const carriesImage = el.tagName === 'IMG' || Boolean(el.querySelector(':scope > img'))
    if (carriesImage || el.classList.contains('avatar-recess')) out.push(el)
  }
  // An <img> inside a recessed wrapper is the same disc counted twice; the wrapper owns the lip.
  return out.filter((el) => !(el.tagName === 'IMG' && el.parentElement?.classList.contains('avatar-recess')))
}

// Each host's avatar addressed by where it SITS, never by the class under test — drop the class
// and the probe still finds the disc and reports it bare, which the sweep alone cannot do (a disc
// with neither an image nor the class is simply not avatar-shaped as far as the sweep can tell).
const PROBES: { where: string; selector: string }[] = [
  { where: 'member row', selector: '[data-probe="member"] img' },
  { where: 'top bar', selector: '[data-probe="topnav"] img' },
  { where: 'activity log actor', selector: '[data-probe="activity"] li > span:first-child' },
  { where: 'first-run picker', selector: '[data-probe="onboarding"] button[aria-label] > :first-child' },
]

// The lip belongs to the disc; for an image that is the wrapper, so climb to it before asking.
function discOf(el: Element): Element {
  return el.parentElement?.classList.contains('avatar-recess') ? el.parentElement : el
}

async function run(): Promise<void> {
  const deadline = Date.now() + 8000
  let ready = false
  while (!ready && Date.now() < deadline) {
    await sleep(50)
    ready = Boolean(document.querySelector('[data-probe="onboarding"] button[aria-label]'))
  }
  if (!ready) return publish({ error: 'the harness tree never rendered' })
  await document.fonts.ready
  await sleep(200)

  const probes: ProbeResult[] = PROBES.map(({ where, selector }) => {
    const el = document.querySelector(selector)
    return { where, found: Boolean(el), recessed: Boolean(el) && isRecessed(discOf(el as Element)) }
  })

  const discs = avatarDiscs()
  // Only a tree that never rendered is an error here; a disc that rendered BARE is a finding, and
  // the report below has to survive to say which one it was.
  if (discs.length < 9) return publish({ error: `only ${discs.length} avatar discs rendered — the tree is incomplete` })
  const misses = discs.filter((el) => !isRecessed(el)).map((el) => ({
    where: whereOf(el),
    size: `${Math.round(el.getBoundingClientRect().width)}px`,
    classes: el.className.toString().slice(0, 120),
  }))

  // MemberCard overlays the presence dot on the avatar's bottom-right corner; the wrapper span must
  // not have moved the box out from under it.
  const memberAvatar = document.querySelector('[data-probe="member"] [class*="avatar-recess"]')
  const dot = document.querySelector('[data-probe="member"] [class*="bg-online"]')
  if (!memberAvatar || !dot) return publish({ error: 'the member row rendered no avatar or no presence dot' })
  const a = memberAvatar.getBoundingClientRect()
  const d = dot.getBoundingClientRect()
  const dotOffsetX = d.right - a.right
  const dotOffsetY = d.bottom - a.bottom

  publish({
    pass: misses.length === 0 && probes.every((p) => p.found && p.recessed)
      && Math.abs(dotOffsetX) <= 1 && Math.abs(dotOffsetY) <= 1,
    discsSeen: discs.length,
    recessed: discs.length - misses.length,
    probes,
    misses,
    recessShadow: getComputedStyle(discs[0], '::after').boxShadow,
    dotOffsetX,
    dotOffsetY,
    dotOnCorner: Math.abs(dotOffsetX) <= 1 && Math.abs(dotOffsetY) <= 1,
  })
}

run().catch((e) => publish({ error: String(e?.stack || e) }))
