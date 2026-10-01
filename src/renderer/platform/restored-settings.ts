// A restored backup's settings: main writes them into config.json, and this window adopts what main
// then holds and shows it — language and theme at once, the rest as each screen next reads it.
import { adoptConfig, getThemePref } from './config-client.js'
import { showStoredLocale } from './i18n.js'
import { applyTheme } from './theme.js'

export async function adoptRestoredSettings(json: string): Promise<void> {
  adoptConfig(await window.bridge.applyRestoredSettings(json))
  showStoredLocale()
  await applyTheme(getThemePref())
}
