import { useCallback } from 'react'
import { useToast } from '../components/toast/ToastProvider.js'
import { useErrorText } from './useErrorText.js'

// One policy for a user-initiated action that nothing else reports on: the failure becomes a toast
// carrying the error's own text.
//
// It exists for the actions handed to a control as `() => void`, where the returned promise is
// dropped. A dropped rejection is a click that did nothing and said nothing, and writing `catch {}`
// at the call site is the same silence with a line of code in front of it. An action whose own
// dialog reports the failure — leaving a space, removing a file — keeps reporting it there and does
// not go through here, or the user is told twice.
export function useRunAction(): (action: () => Promise<unknown>) => void {
  const toast = useToast()
  const errorText = useErrorText()
  return useCallback((action: () => Promise<unknown>) => {
    action().catch((err) => toast.error(errorText(err)))
  }, [toast, errorText])
}
