export interface CancellationSignal {
  aborted: boolean
  reason: Error | null
  onAbort(fn: (reason: Error | null) => void): () => void
}

export interface Cancellation {
  signal: CancellationSignal
  abort(reason?: Error | null): void
}

export declare function createCancellation(): Cancellation
export declare function throwIfAborted(signal: CancellationSignal | null | undefined): void
