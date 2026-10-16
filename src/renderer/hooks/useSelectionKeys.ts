// The select-all chord selects every matching file and opens the column; Esc ends selecting. Both
// act only on a screen that offers selection. The chord inside a text field keeps selecting text
// (the keyboard layer ignores it there), and Esc in a filter that holds text clears the filter
// first, which is the field's own behaviour. A modal, the palette and an open menu answer their
// own Escape ahead of this listener, which runs in the bubble phase and honours defaultPrevented.
// With a dialog open the chord is the dialog's: dispatching a command would close it.
import { useEffect } from 'react'
import { useRegisterCommand } from '../keyboard/KeyboardProvider.js'
import { useAnyModalOpen } from '../components/primitives/modalPresence.js'

interface SelectionKeysArgs {
  enabled: boolean
  selecting: boolean
  onSelectAll: () => void
  onEnd: () => void
}

export function useSelectionKeys({ enabled, selecting, onSelectAll, onEnd }: SelectionKeysArgs): void {
  const modalOpen = useAnyModalOpen()
  useRegisterCommand({
    id: 'selection.selectAll',
    labelKey: 'shortcuts.selectAll',
    group: 'actions',
    when: () => enabled && !modalOpen,
    run: onSelectAll,
  }, [])

  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target
      if (target instanceof HTMLInputElement && target.type === 'search' && target.value !== '') return
      e.preventDefault()
      onEnd()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selecting, onEnd])
}
