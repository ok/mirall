// Why a connection is still relayed with the relay off: a member's own relay carries it, and that is
// their setting, not ours.
import { useTranslation } from 'react-i18next'
import { peopleLabel, type RelayPerson } from '../../model/relay-groups.js'

interface AdoptedRelayNoteProps {
  people: RelayPerson[]
}

export default function AdoptedRelayNote({ people }: AdoptedRelayNoteProps) {
  const { t } = useTranslation()
  return (
    <p role="status" className="border-t border-outline-variant/40 px-6 py-4 text-sm text-on-surface-variant leading-relaxed">
      {t('networkSettings.relays.adoptedWhileOff', { count: people.length, names: peopleLabel(people, t) })}
    </p>
  )
}
