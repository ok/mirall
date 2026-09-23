import type { ArgRule, RequestName, REQUESTS } from './requests.js'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface ArgValues {
  string: string
  number: number
  boolean: boolean
  array: readonly string[]
  object: { [key: string]: JsonValue }
  spaceId: string
  shareId: string
  path: string
}

type ArgsOf<A extends Record<string, ArgRule>> =
  & { [F in keyof A as A[F] extends { optional: true } ? never : F]: ArgValues[A[F]['type']] }
  & { [F in keyof A as A[F] extends { optional: true } ? F : never]?: ArgValues[A[F]['type']] | null }

export type RequestArgs<N extends RequestName> = ArgsOf<(typeof REQUESTS)[N]['args']>
