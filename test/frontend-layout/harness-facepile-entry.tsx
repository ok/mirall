// REGRESSION harness (FIX-RIM: the facepile grows a dark rim when its card lifts) for the ring cut
// around every face in an <AvatarStack>. The ring is a hole in the surface BEHIND the strip, so it
// is only invisible while it carries that surface's CURRENT fill; it was pinned to the host's
// RESTING surface token, so the moment a SpaceCard took `hover:bg-surface-container-highest` the
// ring stayed at `surface-container-lowest` and read as a black ring in dark mode (and a white one
// in light). The +N disc failed the same way from the other side: it was painted in the very token
// the card lifts to, so it vanished into the lifted card.
//
// Mounts the REAL <SpaceCard> against the REAL stylesheet and, in BOTH themes, compares the ring
// colour to the fill behind it — at rest from the computed style, under the cursor by resolving
// the card's own :hover declarations. Colour, not class names: a future card that lifts to a
// different tier has to hand the strip that tier or this fails.

import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import SpaceCard from './../../src/renderer/components/cards/SpaceCard.js'
import type { Space } from '../../src/renderer/types/types.js'

interface StateMetrics {
  cardBg: string
  ringColors: string[]
  chipBg: string
  // The initials disc's own fill. A photo avatar hides it; a faceless member's does not, so it is
  // a fill on the card exactly like the +N disc and fails the same way if it borrows a ramp token.
  faceBg: string
  ringMatchesCard: boolean
  chipReadsAgainstCard: boolean
  faceReadsAgainstCard: boolean
}

// The hole and the surface it is cut from repaint together or not at all: a ring that snaps while
// the card is still fading IS a visible rim, just a short-lived one.
interface TimingMetrics {
  cardProperty: string
  cardDuration: string
  cardTiming: string
  ringProperty: string
  ringDuration: string
  ringTiming: string
  ringTransitions: boolean
  inStep: boolean
}

interface ThemeMetrics {
  theme: string
  rest: StateMetrics
  hover: StateMetrics
}

interface HarnessResults {
  pass: boolean
  error: string | null
  sheetsRead: number
  hoverRulesSeen: number
  avatarCount: number
  timing: TimingMetrics | null
  themes: ThemeMetrics[]
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const pk = (n: number) => String(n).repeat(64).slice(0, 64)

const SPACE: Space = {
  spaceId: 'space-facepile',
  name: 'Design',
  icon: 'hub',
  topic: pk(7),
  created: new Date('2026-01-02T10:00:00Z').toISOString(),
  // A count above the three-face cap, so the +N disc renders next to the faces. The faces
  // themselves come from the fake bridge's `space:members` roster; no avatar images, since the
  // initials fallback is the same disc wearing the same ring.
  memberCount: 4,
  members: [1, 2, 3, 4].map((i) => ({ publicKey: pk(i), driveKey: pk(i), displayName: `Member ${i}` })),
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="p-6 bg-background">
    <SpaceCard space={SPACE} onClick={() => {}} />
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publish(results: Partial<HarnessResults>): void {
  window.__results = { pass: false, error: null, sheetsRead: 0, hoverRulesSeen: 0, avatarCount: 0, timing: null, themes: [], ...results }
}

// getComputedStyle prints a box-shadow as "<color> <offsets>" — the colour is the head of it.
function shadowColor(el: Element): string {
  const shadow = getComputedStyle(el).boxShadow
  return /^(rgba?\([^)]*\)|[a-z]+)/.exec(shadow)?.[0] ?? shadow
}

/**
 * Every declaration of `properties` that a :hover rule matching `el` sets, last one winning — the
 * values the card paints itself and the strip with while the cursor is over it. Recurses into
 * @media/@supports, since Tailwind wraps hover utilities in `@media (hover: hover)`.
 */
function hoverDeclarations(el: Element, properties: string[]): { found: Record<string, string>; sheetsRead: number; hoverRulesSeen: number } {
  const found: Record<string, string> = {}
  let sheetsRead = 0
  let hoverRulesSeen = 0

  const scan = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      const selector = (rule as CSSStyleRule).selectorText
      const nested = (rule as CSSGroupingRule).cssRules
      if (!selector) {
        if (nested) scan(nested)
        continue
      }
      if (nested?.length) scan(nested)
      if (!selector.includes(':hover')) continue
      hoverRulesSeen++
      // With the pseudo stripped, what is left is what the element must match for the rule to
      // apply under the cursor.
      let matches = false
      try {
        matches = el.matches(selector.replace(/:hover/g, ''))
      } catch {
        continue // a selector this browser cannot parse in isolation
      }
      if (!matches) continue
      for (const property of properties) {
        const value = (rule as CSSStyleRule).style.getPropertyValue(property)
        if (value) found[property] = value.trim()
      }
    }
  }

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // cross-origin / unreadable — counted by omission from sheetsRead
    }
    sheetsRead++
    scan(rules)
  }
  return { found, sheetsRead, hoverRulesSeen }
}

// Resolves a declared value ("var(--color-surface-container-high)") to the colour it paints, in the
// theme and cascade the card actually sits in.
function resolveColor(host: Element, value: string): string {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.backgroundColor = value
  host.appendChild(probe)
  const color = getComputedStyle(probe).backgroundColor
  probe.remove()
  return color
}

function timingOf(card: Element, ring: Element): TimingMetrics {
  const c = getComputedStyle(card)
  const r = getComputedStyle(ring)
  const ringTransitions = r.transitionProperty.split(',').some((p) => p.trim() === 'box-shadow' || p.trim() === 'all')
  return {
    cardProperty: c.transitionProperty.includes('background-color') ? 'background-color' : c.transitionProperty,
    cardDuration: c.transitionDuration,
    cardTiming: c.transitionTimingFunction,
    ringProperty: r.transitionProperty,
    ringDuration: r.transitionDuration,
    ringTiming: r.transitionTimingFunction,
    ringTransitions,
    inStep: ringTransitions && r.transitionDuration === c.transitionDuration && r.transitionTimingFunction === c.transitionTimingFunction,
  }
}

function measure(cardBg: string, ringColors: string[], chipBg: string, faceBg: string): StateMetrics {
  return {
    cardBg,
    ringColors,
    chipBg,
    faceBg,
    ringMatchesCard: ringColors.length > 0 && ringColors.every((c) => c === cardBg),
    chipReadsAgainstCard: chipBg !== cardBg,
    faceReadsAgainstCard: faceBg !== cardBg,
  }
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  let card: HTMLElement | null = null
  while (!card && Date.now() < deadline) {
    await sleep(50)
    card = document.querySelector<HTMLElement>('[role="button"][aria-label^="Open"]')
  }
  if (!card) return publish({ error: 'no SpaceCard rendered' })
  const strip = card.querySelector<HTMLElement>('[class*="-space-x-3"]')
  if (!strip) return publish({ error: 'the card renders no avatar strip' })
  const avatars = Array.from(strip.children).filter((el) => el.tagName === 'SPAN').map((el) => el.firstElementChild)
  const chip = Array.from(strip.children).find((el) => el.tagName === 'DIV')
  if (avatars.some((el) => !el)) return publish({ error: 'an avatar span renders no disc' })
  if (!chip) return publish({ error: 'no +N chip rendered — raise memberCount above the cap' })
  await document.fonts.ready
  await sleep(100)

  const { found, sheetsRead, hoverRulesSeen } = hoverDeclarations(card, ['background-color', '--avatar-ring'])
  // An unreadable stylesheet would make every hover assertion below vacuously true.
  if (sheetsRead === 0) return publish({ error: 'no stylesheet was readable — the hover scan would pass vacuously' })
  if (hoverRulesSeen === 0) return publish({ error: 'the stylesheet contains no :hover rules at all — wrong sheet loaded?' })
  if (!found['background-color']) return publish({ error: 'the card sets no hover fill — this harness has nothing to compare against' })

  const timing = timingOf(card, avatars[0] as Element)
  if (!getComputedStyle(card).transitionProperty.includes('background-color')) {
    return publish({ error: 'the card does not transition its fill — this harness has no timing to match against' })
  }

  const themes: ThemeMetrics[] = []
  for (const theme of ['light', 'dark']) {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    // The card carries `transition-colors`, so a theme flip is animated: measuring inside that
    // window reads a blend of the two themes and compares it against nothing real.
    await sleep(600)
    const faceBg = getComputedStyle(avatars[0] as Element).backgroundColor
    const rest = measure(
      getComputedStyle(card).backgroundColor,
      avatars.map((el) => shadowColor(el as Element)),
      getComputedStyle(chip).backgroundColor,
      faceBg,
    )
    // Under the cursor the card repaints and so must everything cut from it; resolve the three
    // declared values in this theme rather than forcing a pseudo-class the page cannot force.
    const hoverBg = resolveColor(card, found['background-color'])
    // No override means the ring simply keeps its resting fill under the cursor — which IS the
    // defect, so model it that way rather than as an absent colour.
    const hoverRing = found['--avatar-ring'] ? resolveColor(card, found['--avatar-ring']) : rest.ringColors[0]
    // The +N disc is painted in a neutral outside the ramp, so its fill is the same in both
    // states — what changes under it is the card, which is the whole point of measuring it here.
    const hoverChip = getComputedStyle(chip).backgroundColor
    // Both discs are painted in fills the card cannot adopt, so only the card moves under them.
    themes.push({ theme, rest, hover: measure(hoverBg, avatars.map(() => hoverRing), hoverChip, faceBg) })
  }
  document.documentElement.classList.remove('dark')

  publish({
    pass: timing.inStep && themes.every((t) =>
      [t.rest, t.hover].every((s) => s.ringMatchesCard && s.chipReadsAgainstCard && s.faceReadsAgainstCard)),
    sheetsRead,
    hoverRulesSeen,
    avatarCount: avatars.length,
    timing,
    themes,
  })
}

run().catch((e) => publish({ error: String(e?.stack || e) }))
