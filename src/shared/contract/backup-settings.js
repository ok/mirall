// The config.json groups a backup carries and a restore puts back: the preferences that follow the
// user to a new device. Device choices (login item, tray, cache size), window placement, view state,
// the relay (its seed is bound to the device) and the backup's own bookkeeping stay behind.
export const BACKUP_SETTING_GROUPS = Object.freeze(['appearance', 'downloads', 'network', 'notifications'])
