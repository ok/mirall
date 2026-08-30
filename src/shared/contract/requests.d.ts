export type ArgType = 'string' | 'number' | 'boolean' | 'array' | 'spaceId' | 'shareId' | 'path'
export interface ArgRule { type: ArgType; optional?: boolean; max?: number }
export interface RequestSpec { kind: 'query' | 'command'; args: Record<string, ArgRule>; fails?: readonly string[]; cancellable?: boolean }
export declare const ARG: Readonly<Record<ArgType, ArgType>>
export declare const REQUESTS: Readonly<Record<string, RequestSpec>>
export declare const REQUEST_NAMES: readonly string[]
export declare const UNREFERENCED_REQUESTS: readonly string[]
