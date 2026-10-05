// Where a restored profile stands on its way back to being writable: no peer holding it is
// connected, a holder has more of it, its blocks are still arriving, it matches and is waiting out
// the dwell, or it caught up.
export const RESTORE_VERDICT = Object.freeze({
  NO_HOLDER: 'no-holder',
  BEHIND: 'behind',
  DOWNLOADING: 'downloading',
  DWELL: 'dwell',
  CAUGHT_UP: 'caught-up',
})

export const RESTORE_VERDICTS = Object.freeze(Object.values(RESTORE_VERDICT))
