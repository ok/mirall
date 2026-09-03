export interface MountFault {
  status: string
  code: string | null
}

export function isMountFault(status: string | null | undefined): boolean
export function mountFault(status: string | null | undefined, lastError?: string | null): MountFault | null
