import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { errorTextFor } from '../errorText.js'

export function useErrorText(): (err: unknown, fallbackKey?: string) => string {
  const { t } = useTranslation('errors')
  return useCallback(
    (err: unknown, fallbackKey?: string) => errorTextFor(err, (key: string) => t(key), fallbackKey),
    [t],
  )
}
