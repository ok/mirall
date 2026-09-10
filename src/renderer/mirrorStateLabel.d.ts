import type { MirrorParticipant } from './types.js'

export function mirrorStateLabelKey(state: MirrorParticipant['state'], ownerOnline?: boolean): string
