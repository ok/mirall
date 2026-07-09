import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../components/primitives/Modal.js'
import IconButton from '../components/primitives/IconButton.js'
import { useKeyboard } from './KeyboardProvider.js'
import AcceleratorLabel from './AcceleratorLabel.js'
import { KEYBOARD_SHORTCUTS, type KnownCommand } from './known-commands.js'
import type { CommandGroup } from './registry.js'

const GROUP_ORDER: CommandGroup[] = ['system', 'navigation', 'actions', 'space']

export default function ShortcutsHint() {
  const { t } = useTranslation()
  const { cheatsheetOpen, closeCheatsheet } = useKeyboard()

  const grouped = useMemo<Record<CommandGroup, KnownCommand[]>>(() => {
    const out: Record<CommandGroup, KnownCommand[]> = {
      system: [],
      navigation: [],
      actions: [],
      space: [],
    }
    for (const c of KEYBOARD_SHORTCUTS) {
      out[c.group].push(c)
    }
    return out
  }, [])

  return (
    <Modal isOpen={cheatsheetOpen} onClose={closeCheatsheet} ariaLabel={t('shortcuts.title')} panelClassName="glass-modal w-full max-w-xl rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative">
      <div className="px-10 pt-10 pb-10">
        {/* First focusable element → FocusScope autoFocus lands here instead of
            the whole dialog, so the panel doesn't get a focus ring. */}
        <IconButton
          icon="close"
          onClick={closeCheatsheet}
          ariaLabel={t('actions.close')}
          iconClassName="text-secondary"
          className="absolute top-6 right-6"
        />
        <div className="mb-8">
          <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight mb-2">
            {t('shortcuts.title')}
          </h1>
          <p className="text-on-surface-variant font-medium text-sm">{t('shortcuts.intro')}</p>
        </div>
        <div className="space-y-6">
          {GROUP_ORDER.map((group) => {
            const items = grouped[group]
            if (items.length === 0) return null
            return (
              <section key={group}>
                <h2 className="text-xs font-bold text-secondary uppercase tracking-wide mb-3">
                  {t(`shortcuts.groups.${group}`)}
                </h2>
                <table className="w-full">
                  <tbody>
                    {items.map((c) => (
                      <tr key={c.id}>
                        <td className="py-1.5 text-on-surface text-sm">
                          {t(c.labelKey)}
                        </td>
                        <td className="py-1.5 text-right font-mono text-sm text-on-surface-variant whitespace-nowrap pl-8">
                          <AcceleratorLabel spec={c.accelerator} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
