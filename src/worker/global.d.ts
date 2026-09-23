// The timers the Bare runtime installs as globals, which no installed package declares.
interface BareTimer {
  ref(): BareTimer
  unref(): BareTimer
  hasRef(): boolean
  refresh(): BareTimer
}

declare function setTimeout(callback: (...args: never[]) => void, delay?: number): BareTimer
declare function clearTimeout(timer: BareTimer | null | undefined): void
declare function setInterval(callback: (...args: never[]) => void, delay?: number): BareTimer
declare function clearInterval(timer: BareTimer | null | undefined): void
