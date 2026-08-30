import type { RequestSpec } from '../contract/requests.js'

export interface HandlerEntry {
  name: string
  fn: (msg: Record<string, unknown>) => unknown
  spec: RequestSpec
}

export interface HandlerTable {
  register (name: string, fn: (msg: Record<string, unknown>) => unknown): HandlerTable
  get (name: string): HandlerEntry | null
  has (name: string): boolean
  names (): string[]
  size (): number
}

import type { ArgRule } from '../contract/requests.js'

export declare function validateArgs (shape: Record<string, ArgRule>, msg: Record<string, unknown>): string | null
export declare function createHandlerTable (opts?: { requests?: Record<string, RequestSpec> }): HandlerTable
