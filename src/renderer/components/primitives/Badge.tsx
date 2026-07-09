interface BadgeProps {
  label: string
  classes: string
  className?: string
}

export default function Badge({ label, classes, className }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center leading-none px-3 pt-[7px] pb-[5px] text-[10px] font-bold rounded-full uppercase tracking-wider border border-outline ${classes}${className ? ` ${className}` : ''}`}
    >
      {label}
    </span>
  )
}
