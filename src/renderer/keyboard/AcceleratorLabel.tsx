import { acceleratorParts, isMacRuntime } from './accelerator.js'

interface Props {
  spec: string
  className?: string
}

// Renders an accelerator as discrete symbol spans. On mac the inter-symbol gap
// is an explicit margin rather than a space character, so it stays tight and
// consistent regardless of the surrounding font (a literal space renders very
// wide, especially in a monospace face). Tune the gap via the ml-[…] value.
export default function AcceleratorLabel({ spec, className }: Props) {
  const parts = acceleratorParts(spec)
  if (!isMacRuntime) {
    // Windows/Linux keep the conventional "Ctrl+Shift+H" plus-joined form.
    return <span className={className}>{parts.join('+')}</span>
  }
  return (
    <span className={className}>
      {parts.map((part, i) => (
        <span key={i} className={i > 0 ? 'ml-[0.15em]' : undefined}>{part}</span>
      ))}
    </span>
  )
}
