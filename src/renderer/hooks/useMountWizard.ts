import { useCallback, useEffect, useRef, useState } from 'react'
import { usePreviewFlow, type PreviewHandle } from './usePreviewFlow.js'
import { useToast } from '../components/toast/ToastProvider.js'
import { useErrorText } from './useErrorText.js'
import type { MountValidationResult, PreviewProgress } from '../types.js'

type MountWizardStepName = 'edit' | 'preview'

interface MountWizardOps {
  isOpen: boolean
  initialPath?: string
  // The identity the form belongs to. Changing it while the wizard is open starts it over, which is
  // what keeps a re-targeted dialog from carrying the previous folder's path and verdict.
  resetKey?: string
  validate: (path: string) => Promise<MountValidationResult>
  startPreview: (path: string, onProgress: (p: PreviewProgress) => void) => PreviewHandle
  cancelPreview: (previewId: string) => void
  commit: (path: string) => Promise<void>
  onCommitted: () => void
}

// The two folder-mount wizards are one state machine over three injected calls — validate a path,
// scan it, commit it.
export function useMountWizard({
  isOpen,
  initialPath = '',
  resetKey = '',
  validate,
  startPreview,
  cancelPreview,
  commit,
  onCommitted,
}: MountWizardOps) {
  const toast = useToast()
  const errorText = useErrorText()
  const [mountPath, setMountPath] = useState(initialPath)
  const [validation, setValidation] = useState<MountValidationResult | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [step, setStep] = useState<MountWizardStepName>('edit')
  const [submitting, setSubmitting] = useState(false)
  const { preview, progress, loading, run, cancel, reset } = usePreviewFlow(cancelPreview)

  // The injected calls are read through a ref, never through a dependency list: both callers build
  // them as inline arrows, so a validate() in the deps would clear the verdict, re-render and spin
  // (the technique useRegisterCommand uses for `run`; mount-wizard-single-source.test.js pins it).
  const opsRef = useRef({ validate, startPreview, commit, onCommitted })
  opsRef.current = { validate, startPreview, commit, onCommitted }

  useEffect(() => {
    if (!isOpen) return
    setMountPath(initialPath)
    setValidation(null)
    setValidationError(null)
    setStep('edit')
    setSubmitting(false)
    reset()
    return () => { cancel() }
  }, [isOpen, initialPath, resetKey])

  // Deliberately NOT on the query store, though it is param-keyed and looks like a query: this is a
  // point-in-time filesystem probe. The folder can be deleted, unmounted or filled between two opens
  // of the dialog, and a cached verdict would answer for a path the user has since changed. The
  // cancel flag is what keeps a superseded answer off the screen.
  useEffect(() => {
    if (!isOpen || !mountPath) return
    let cancelled = false
    setValidation(null)
    setValidationError(null)
    opsRef.current.validate(mountPath).then(
      (result) => { if (!cancelled) setValidation(result) },
      (err) => {
        if (cancelled) return
        setValidationError(errorText(err))
      },
    )
    return () => { cancelled = true }
  }, [isOpen, mountPath, errorText])

  const pathValid = !!validation && !validationError && mountPath.length > 0

  // Returns what was picked so a caller can derive from it — Add Folder seeds the share name — rather
  // than watching mountPath and guessing whether the user or the reset moved it.
  const browse = useCallback(async () => {
    const picked = await window.bridge.browseShareFolder()
    if (picked) setMountPath(picked)
    return picked
  }, [])

  const next = useCallback(async () => {
    setStep('preview')
    try {
      await run((onProgress) => opsRef.current.startPreview(mountPath, onProgress))
    } catch (err) {
      // Cancelling the scan is the user's own act, and backToEdit has already handled it.
      const code = (err as { code?: string } | null)?.code
      if (code === 'PREVIEW_CANCELLED') return
      toast.error(errorText(err))
      setStep('edit')
    }
  }, [run, mountPath, toast, errorText])

  const backToEdit = useCallback(() => {
    cancel()
    setStep('edit')
  }, [cancel])

  const confirm = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await opsRef.current.commit(mountPath)
      opsRef.current.onCommitted()
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setSubmitting(false)
    }
  }, [submitting, mountPath, toast, errorText])

  return {
    mountPath,
    setMountPath,
    browse,
    validation,
    validationError,
    pathValid,
    step,
    preview,
    progress,
    previewLoading: loading,
    submitting,
    next,
    backToEdit,
    confirm,
  }
}
