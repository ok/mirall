import type { SpaceMember } from './types.js'

export interface MemberSummary {
  total: number
  stack: SpaceMember[]
  overflow: number
}

export function summarizeMembers(members: SpaceMember[], opts?: { stackMax?: number }): MemberSummary
