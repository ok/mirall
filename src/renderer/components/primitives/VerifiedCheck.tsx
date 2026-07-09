import Icon from './Icon'

// Informational indicator (not a button): the file's content hash was verified
// equal to the sender's hash on download. A shield-check ('verified_user') reads
// as "validated / integrity confirmed". It sits inline just left of the status
// pill — information groups with information, leaving the row's right edge for
// action buttons — sized to the pill's visual weight. success-token green per the
// design system.
export default function VerifiedCheck({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="shrink-0 inline-flex items-center"
    >
      <Icon name="verified_user" size={20} className="text-on-success" />
    </span>
  )
}
