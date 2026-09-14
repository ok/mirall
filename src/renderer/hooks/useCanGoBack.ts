import { useAnyModalOpen } from '../components/primitives/modalPresence.js'
import type { Screen } from '../navigation.js'

// Whether the OS-level back affordances (mouse back button, swipe, mod+←) should do anything: not
// at the root, and not out from under an open dialog — any dialog, which is why it asks the dialog
// primitive rather than a list of flags a screen has to remember to update.
export function useCanGoBack(screen: Screen): boolean {
  const anyModalOpen = useAnyModalOpen()
  return !anyModalOpen && screen !== 'spaces'
}
