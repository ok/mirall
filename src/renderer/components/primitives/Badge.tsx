// Small inline label. `classes` carries the whole tone — background AND text colour — because the
// component has no tone vocabulary of its own yet; passing only a background leaves the text at the
// inherited colour, which is the one way to make it unreadable.
interface BadgeProps {
  label: string
  classes: string
  className?: string
  // The accessible name, for a badge whose visible word is ambiguous on its own. A file row's
  // badge is the state of ONE file; without this it reads as an unattached "AVAILABLE".
  srLabel?: string
}

export default function Badge({ label, classes, className, srLabel }: BadgeProps) {
  return (
    <span
      aria-label={srLabel}
      className={`inline-flex items-center leading-none px-3 pt-[7px] pb-[5px] text-[10px] font-bold rounded-full uppercase tracking-wider border border-outline ${classes}${className ? ` ${className}` : ''}`}
    >
      {label}
    </span>
  )
}
