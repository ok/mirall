import FolderWorkStrip from './FolderWorkStrip.js'
import type { ComponentProps } from 'react'

type Strip = ComponentProps<typeof FolderWorkStrip>['strip']

interface FolderStripBandProps {
  strips: Strip[]
  overLimit: Strip | null
  ownerName: string
  onAction: ComponentProps<typeof FolderWorkStrip>['onAction']
  workAnnouncement: string
}

/**
 * The work-strip band above a folder's listing, plus the two live regions that go with it.
 *
 * The band sits outside the scroll pane so folder state can never scroll away from the folder it
 * describes, and it is a band rather than a reserved slot: no strip, no height.
 */
export default function FolderStripBand({ strips, overLimit, ownerName, onAction, workAnnouncement }: FolderStripBandProps) {
  return (
    <>
      {/* The container is ALWAYS mounted because the over-limit notice needs a live region that
          pre-exists: a role=status added to the DOM already-populated is not reliably announced.
          It is `sr-only` while empty, so it still costs no height. */}
      <div className={`shrink-0 space-y-2${strips.length > 0 ? ' pb-4' : ''}`}>
        {strips.filter((strip) => strip.id !== 'over-limit').map((strip) => (
          <FolderWorkStrip key={strip.id} strip={strip} ownerName={ownerName} onAction={onAction} />
        ))}
        <div
          role="status"
          aria-live="polite"
          className={overLimit ? '' : 'sr-only'}
        >
          {overLimit ? <FolderWorkStrip strip={overLimit} ownerName={ownerName} onAction={onAction} /> : null}
        </div>
      </div>

      {/* The counts in the working strip change about twice a second, so it is deliberately NOT a
          live region — ProgressBar makes the same call for the same reason. This carries a
          count-free sentence instead, announced once when the scan starts and once when it ends. */}
      <div role="status" aria-live="polite" className="sr-only">
        {workAnnouncement}
      </div>
    </>
  )
}
