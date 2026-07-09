interface ProgressBarProps {
  // 0–100; clamped by the caller.
  value: number
  // Accessible name for the progressbar (required — this is the a11y contract).
  label: string
  // Optional visual meta line below the bar (e.g. "1.2 MB / 4 MB • 3 MB/s").
  meta?: string
}

// Presentation-only progress bar. Deliberately renders NO action buttons —
// pause/cancel/reveal stay with each caller — so it can be reused for folder
// mirror file rows, which must not expose pause/stop (those downloads are
// driven by the materialize loop, not a cancellable transfer).
//
// Accessibility: relies on role=progressbar + aria-valuenow (announced by
// assistive tech on focus) rather than an aria-live region, which at the 250ms
// progress cadence would spam VoiceOver. The width animation is disabled under
// prefers-reduced-motion.
export default function ProgressBar({ value, label, meta }: ProgressBarProps) {
  return (
    <div className="mt-2 w-60">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 bg-surface-container-highest rounded-full overflow-hidden"
      >
        <div
          className="h-full bg-on-info rounded-full transition-all motion-reduce:transition-none"
          style={{ width: `${value}%` }}
        />
      </div>
      {meta != null && (
        <p className="text-[10px] text-on-surface-variant mt-1">{meta}</p>
      )}
    </div>
  )
}
