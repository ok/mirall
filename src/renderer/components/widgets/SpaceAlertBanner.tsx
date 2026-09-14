import Icon from '../primitives/Icon.js'

/**
 * A full-width warning above a space's content: one sentence, no action.
 *
 * `role="alert"` rather than `role="status"`: both callers state a condition the user has to act on
 * outside the app — a space that predates encryption, and a creator key that no longer matches.
 */
export default function SpaceAlertBanner({ text }: { text: string }) {
  return (
    <div className="shrink-0 pb-4">
      <div role="alert" className="rounded-2xl p-4 flex items-center gap-3 bg-error-container">
        <Icon name="warning" className="text-on-error-container shrink-0" />
        <p className="flex-1 min-w-0 font-bold text-on-error-container">{text}</p>
      </div>
    </div>
  )
}
