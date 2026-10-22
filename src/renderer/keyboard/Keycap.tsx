import AcceleratorLabel from './AcceleratorLabel.js'

interface KeycapProps {
  spec: string | undefined
  ariaHidden?: boolean
  className?: string
}

export default function Keycap({ spec, ariaHidden, className }: KeycapProps) {
  if (!spec) return null
  return (
    <kbd
      aria-hidden={ariaHidden || undefined}
      className={`font-mono text-xs font-normal px-1.5 py-0.5 rounded bg-surface-control text-on-surface-variant whitespace-nowrap${className ? ` ${className}` : ''}`}
    >
      <AcceleratorLabel spec={spec} />
    </kbd>
  )
}
