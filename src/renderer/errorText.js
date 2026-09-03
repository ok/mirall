import { errorI18nKey } from './errorMessages.js'

export const FALLBACK_KEY = 'unexpected'

function errorCodeOf (err) {
  if (typeof err !== 'object' || err === null) return null
  return typeof err.code === 'string' ? err.code : null
}

// The single place a failure becomes text a person reads.
//
// The fallback is deliberately NOT err.message. A worker message is English written for a log
// ("file path rejected — resolves outside the share folder: ../x", "worker is still starting"), and
// using it as the fallback is what let unmapped codes ship English into every locale silently: the
// failure mode renders plausible text, so nothing catches it. Falling back to a localized generic
// sentence makes the failure mode "vague but translated", and contract-errors.test.js then makes
// vagueness impossible for any code a user can reach. The raw message is not lost — it reaches the
// dev console below, and the diagnostics log a bug report carries.
export function errorTextFor (err, t, fallbackKey = FALLBACK_KEY) {
  const code = errorCodeOf(err)
  const key = errorI18nKey(code, fallbackKey)
  if (key === fallbackKey && typeof window !== 'undefined' && window.bridge?.isDev?.()) {
    console.warn('[i18n] no user-facing message for error code', code, err?.message ?? String(err))
  }
  return t(key)
}
