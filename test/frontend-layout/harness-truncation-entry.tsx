// Text-truncation harness (LOCAL/dev-machine only — spawns a real Electron GUI process, like the
// agent-desktop frontend suite). Mounts the REAL <PathRow> and <FileName> in a deliberately narrow
// field and asserts the text never escapes it.
//
// Both build middle truncation from the same two-span flex trick: a `truncate` head that gives way
// and a `shrink-0` tail that stays. That tail is the failure mode — when the final path segment is
// longer than the field on its own there is nothing left to shrink, so it runs straight out of the
// field and over the Browse button beside it. Geometry is the only honest test of that: the text
// either fits inside the field's content box or it does not.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import PathRow from './../../src/renderer/components/widgets/PathRow.js'
import FileName from './../../src/renderer/components/widgets/FileName.js'

const LONG_PATH = '/Users/oliver/Music/Sets/Boiler Room Carl Cox in Ibiza, Aug 15, 2013 (DJ Mix)'
const LONG_FILE = 'Boiler.Room.Carl.Cox.in.Ibiza.August.15.2013.DJ.Mix.2160p.HDR.remux.mkv'

interface HarnessResults {
  pass: boolean
  error: string | null
  pathOverflow: number
  pathEndsWith: string
  pathEllipsised: boolean
  nameOverflow: number
  nameEndsWith: string
}

declare global {
  interface Window { __results: HarnessResults }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ width: 520 }} className="p-4 space-y-4">
    <div data-test="path">
      <PathRow path={LONG_PATH} onAction={() => {}} />
    </div>
    <div data-test="name" className="flex bg-surface-container-low rounded-xl px-5 py-3.5">
      <FileName name={LONG_FILE} className="text-sm text-accent font-medium" />
    </div>
  </div>,
)

// How far the widest rendered text run escapes its field's content box, in px. <= 0 is the
// invariant; a positive number is text sitting on top of whatever comes next.
function overflowOf(scopeSel: string, fieldSel: string): number {
  const field = document.querySelector(`${scopeSel} ${fieldSel}`) as HTMLElement
  const style = getComputedStyle(field)
  const limit = field.getBoundingClientRect().right - parseFloat(style.paddingRight)
  let worst = -Infinity
  for (const span of Array.from(field.querySelectorAll('span'))) {
    // sr-only nodes are clipped to 1px and carry the full string by design.
    if ((span as HTMLElement).className.includes('sr-only')) continue
    worst = Math.max(worst, span.getBoundingClientRect().right - limit)
  }
  return Math.round(worst * 10) / 10
}

// The last visible run — proof the ending stayed pinned rather than being ellipsised away.
function lastRun(scopeSel: string, fieldSel: string): string {
  const spans = Array.from(document.querySelectorAll<HTMLElement>(`${scopeSel} ${fieldSel} span`))
    .filter((s) => !s.className.includes('sr-only') && s.textContent)
  return spans.at(-1)?.textContent ?? ''
}

setTimeout(() => {
  try {
    const pathField = '.bg-surface-container-low'
    const results: HarnessResults = {
      error: null,
      pathOverflow: overflowOf('[data-test="path"]', pathField),
      pathEndsWith: lastRun('[data-test="path"]', pathField),
      // An ellipsis is actually being painted: the flexible run's content is wider than the box
      // it is allowed to occupy. (innerText is no good here — the sr-only node carries the whole
      // path by design, so it never gets shorter.)
      pathEllipsised: (() => {
        const run = document.querySelector('[data-test="path"] .bg-surface-container-low span span') as HTMLElement
        return run.scrollWidth > run.clientWidth + 1
      })(),
      nameOverflow: overflowOf('[data-test="name"]', ''),
      nameEndsWith: lastRun('[data-test="name"]', ''),
      pass: false,
    }
    results.pass =
      results.pathOverflow <= 0 &&
      results.nameOverflow <= 0 &&
      results.pathEllipsised &&
      // The distinguishing ending survives on both — middle truncation, not end truncation.
      results.pathEndsWith.endsWith('(DJ Mix)') &&
      results.nameEndsWith === '.mkv'
    window.__results = results
  } catch (e) {
    window.__results = {
      pass: false, error: String(e), pathOverflow: 0, pathEndsWith: '',
      pathEllipsised: false, nameOverflow: 0, nameEndsWith: '',
    }
  }
}, 400)
