// The windows the transfer rate history is kept and charted for. PERSISTED on the wire as the
// `transfers:rates` window argument.
export const RATE_WINDOW = Object.freeze({ MINUTES: '5m', HOUR: '1h', TODAY: 'today' })
export const RATE_WINDOWS = Object.freeze(Object.values(RATE_WINDOW))
/** @typedef {(typeof RATE_WINDOWS)[number]} RateWindow */
