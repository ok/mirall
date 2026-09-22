import { useCallback, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { resizeAvatar, AVATAR_INPUT_MAX_BYTES } from '../format/utils.js'

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// The avatar a profile form is editing, and the picker that changes it. A file that cannot be read
// or decoded is said inline, beside the picture: the profile screens report there because
// onboarding renders before any toast region exists. Only the latest pick settles the avatar and the
// error, however the reads finish. The input is cleared on a refusal so picking the same file again
// fires a change.
export function useAvatarPicker(initial: string | null) {
  const { t } = useTranslation()
  const [avatar, setAvatar] = useState<string | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const pickSeq = useRef(0)

  const onChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const file = input.files?.[0]
    if (!file) return
    const seq = ++pickSeq.current
    if (file.size > AVATAR_INPUT_MAX_BYTES) {
      setError(t('settings.avatarTooLarge'))
      input.value = ''
      return
    }
    readAsDataUrl(file).then(resizeAvatar).then((resized) => {
      if (seq !== pickSeq.current) return
      setAvatar(resized)
      setError(null)
    }, () => {
      if (seq !== pickSeq.current) return
      setError(t('settings.avatarUnreadable'))
      input.value = ''
    })
  }, [t])

  return { avatar, error, onChange }
}
