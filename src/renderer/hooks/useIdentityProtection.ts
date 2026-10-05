// How this device protects the identity key (system keychain, a weak fallback, or none), read once:
// it cannot change while the app runs. null until the read lands, and on failure.
import { useEffect, useState } from 'react'
import type { IdentityProtection } from '../platform/global.js'

export function useIdentityProtection(): IdentityProtection | null {
  const [protection, setProtection] = useState<IdentityProtection | null>(null)
  useEffect(() => {
    window.bridge.getIdentityProtection().then(setProtection).catch(() => {})
  }, [])
  return protection
}
