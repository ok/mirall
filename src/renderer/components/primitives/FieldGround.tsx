import { createContext, useContext, type ReactNode } from 'react'

// Which ramp step fills a field, by the ground it sits on. A modal panel is `-lowest`, so a field in
// one takes `low`; every field outside a modal sits on a `-low` card, so it takes `lowest`, or it
// would vanish into the card. Modal provides `low` to its contents; `lowest` is the default.
export type FieldFill = 'low' | 'lowest'

export const FIELD_FILL: Record<FieldFill, string> = {
  low: 'bg-surface-container-low',
  lowest: 'bg-surface-container-lowest',
}

const FieldFillContext = createContext<FieldFill>('lowest')

export function FieldGround({ fill, children }: { fill: FieldFill; children: ReactNode }) {
  return <FieldFillContext value={fill}>{children}</FieldFillContext>
}

export function useFieldFill(): FieldFill {
  return useContext(FieldFillContext)
}
