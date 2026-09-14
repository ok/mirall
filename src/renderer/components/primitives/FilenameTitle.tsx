import { useTranslation } from 'react-i18next'
import { useLayoutEffect, useRef, useState } from 'react'
import { middleTruncateToWidth } from '../../sharePaths.js'

interface FilenameTitleProps {
  i18nKey: string
  name: string
}

// Modal title carrying a user-supplied name interpolated into a translated sentence such as
// `Remove “{{name}}”?`. The name gets its own line under the verb phrase, middle-truncated to the
// modal width — `High.Plains.Dri…BluRay.mp4` — so both ends (and the extension) stay readable. The
// truncation is measured against the real font and rendered as one text node, so it never gaps or
// overlaps the punctuation. The name is interpolated with a private-use sentinel and the result
// split on it, which locates it per language without touching locale strings; the opening quote is
// peeled off the verb phrase so it rides with the name.
const NAME_SLOT = String.fromCharCode(0xe000)

function peelTitle(raw: string): { verb: string; lead: string; after: string } {
  const [before = '', after = ''] = raw.split(NAME_SLOT)
  const trimmed = before.replace(/\s+$/, '')
  const sp = trimmed.lastIndexOf(' ')
  const verb = sp >= 0 ? trimmed.slice(0, sp) : ''
  const lead = sp >= 0 ? trimmed.slice(sp + 1) : trimmed
  return { verb, lead, after }
}

export default function FilenameTitle({ i18nKey, name }: FilenameTitleProps) {
  const { t } = useTranslation()
  const { verb, lead, after } = peelTitle(t(i18nKey, { name: NAME_SLOT }))
  const hostRef = useRef<HTMLHeadingElement>(null)
  const nameRef = useRef<HTMLSpanElement>(null)
  const [display, setDisplay] = useState(name)

  useLayoutEffect(() => {
    const host = hostRef.current
    const nameEl = nameRef.current
    if (!host || !nameEl) return
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return

    const remeasure = () => {
      const cs = getComputedStyle(nameEl)
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      // letterSpacing lets measureText account for `tracking-tight`; ignore if the
      // engine doesn't support the canvas property.
      try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = cs.letterSpacing } catch { /* older engines */ }
      // The name gets a whole line, so its budget is the host width minus the
      // quote + trailing punctuation that share that line.
      const measure = (candidate: string) => ctx.measureText(lead + candidate + after).width
      setDisplay(middleTruncateToWidth(name, host.clientWidth, measure))
    }

    remeasure()
    const ro = new ResizeObserver(remeasure)
    ro.observe(host)
    let cancelled = false
    document.fonts?.ready.then(() => { if (!cancelled) remeasure() })
    return () => { cancelled = true; ro.disconnect() }
  }, [i18nKey, name, lead, after])

  return (
    <h1
      ref={hostRef}
      className="font-headline text-2xl font-extrabold text-accent tracking-tight flex flex-1 flex-wrap items-baseline gap-x-2 min-w-0"
    >
      {/* The visible parts are aria-hidden and the full, untruncated sentence is
          carried by a single sr-only node, so assistive tech (and the AX-tree
          frontend suite) reads a clean title instead of the `…`-truncated name. */}
      {verb && <span aria-hidden="true" className="whitespace-nowrap">{verb}</span>}
      <span aria-hidden="true" className="whitespace-nowrap min-w-0 max-w-full">
        {lead}
        <span ref={nameRef} data-fit-name="">{display}</span>
        {after}
      </span>
      <span className="sr-only">{t(i18nKey, { name })}</span>
    </h1>
  )
}
