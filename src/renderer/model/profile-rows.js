// Pure description builders for the Profile screen's "This device" rows. Plain JS so it
// unit-tests under brittle-node; `t` is injected to keep it Node-loadable.
/** @import { TFunction } from 'i18next' */
/** @import { AuditConfig, AuditStats, ConnectivityState } from '../types/types.js' */

/** @param {TFunction} t @param {ConnectivityState} state @param {number | null | undefined} peerCount */
export function connectionDesc(t, state, peerCount) {
  return t('account.connectionDesc', {
    state: t(`connectivity.${state}`),
    peers: t('settings.networkStatusDesc', { count: peerCount ?? 0 }),
  })
}

// Never report "0 events" before the stats land — an empty log and an unread one look identical
// to the user, and only one of them is true.
/** @param {TFunction} t @param {AuditConfig | null} config @param {AuditStats | null} stats */
export function activityDesc(t, config, stats) {
  if (!config || !stats) return t('account.activityDesc')
  const kept = t('activityLogSettings.openLogSummary', { count: stats.count })
  return config.enabled ? kept : t('account.recordingOff', { kept })
}
