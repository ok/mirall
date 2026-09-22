import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../components/toast/ToastProvider.js'
import { useErrorText } from './useErrorText.js'
import { DENY_OUTCOME } from '../../shared/contract/deny-outcome.js'
import type { DenyMemberResult } from '../../shared/contract/responses.js'
import type { JoinRequest } from '../types/types.js'

type MembershipRequestsInput = {
  spaceId: string
  requests: JoinRequest[]
  approveMember: (spaceId: string, publicKey: string) => Promise<void>
  denyMember: (spaceId: string, publicKey: string) => Promise<DenyMemberResult>
}

/**
 * Approving and denying join requests, and the in-flight set the controls disable themselves on.
 *
 * `busy` is keyed by public key rather than a single boolean because the requests are a list: one
 * slow approval must not freeze the rest of the rows, and a second click on the same row must not
 * send a second write.
 */
export function useMembershipRequests({ spaceId, requests, approveMember, denyMember }: MembershipRequestsInput) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const markBusy = (pk: string) => setBusy((prev) => new Set(prev).add(pk))
  const clearBusy = (pk: string) => setBusy((prev) => {
    if (!prev.has(pk)) return prev
    const next = new Set(prev)
    next.delete(pk)
    return next
  })

  async function decide(pk: string, write: (spaceId: string, publicKey: string) => Promise<void>) {
    if (busy.has(pk)) return
    markBusy(pk)
    try {
      await write(spaceId, pk)
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      clearBusy(pk)
    }
  }

  // A co-member can admit the peer while our Deny is on screen. Approval cannot be taken back yet,
  // so the consequence stays up until the user dismisses it.
  async function denyAndReport(sid: string, pk: string) {
    const { outcome } = await denyMember(sid, pk)
    if (outcome !== DENY_OUTCOME.ALREADY_APPROVED) return
    const name = requests.find((r) => r.publicKey === pk)?.displayName ?? t('member.unknown')
    toast.warning(t('member.denyAlreadyApproved', { name }), { duration: 0 })
  }

  // Approving a batch runs one at a time on purpose: each approval writes membership and re-reads
  // the roster, and firing them together lets the last write land on a roster the earlier ones had
  // already grown. Every failure is counted rather than raised, so a batch reports once instead of
  // stacking a toast per request behind a closed dialog.
  async function approveMany(keys: string[]) {
    const pending = keys.filter((pk) => !busy.has(pk))
    if (pending.length === 0) return
    pending.forEach(markBusy)
    let done = 0
    for (const pk of pending) {
      try {
        await approveMember(spaceId, pk)
        done++
      } catch {
        // Counted in the summary below.
      } finally {
        clearBusy(pk)
      }
    }
    if (done < pending.length) {
      toast.error(t('space.approvePartial', { done, total: pending.length, failed: pending.length - done }))
    }
  }

  return {
    busy,
    approve: (pk: string) => decide(pk, approveMember),
    deny: (pk: string) => decide(pk, denyAndReport),
    approveMany,
  }
}
