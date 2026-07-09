// i18next setup: bundled locale resources, language resolution (persisted pref → system locale → English), tray-label sync on change.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { getLocalePref, setLocalePref } from './config-client.js'
import enCommon from './locales/en/common.json'
import enErrors from './locales/en/errors.json'
import deCommon from './locales/de/common.json'
import deErrors from './locales/de/errors.json'
import frCommon from './locales/fr/common.json'
import frErrors from './locales/fr/errors.json'
import esCommon from './locales/es/common.json'
import esErrors from './locales/es/errors.json'
import itCommon from './locales/it/common.json'
import itErrors from './locales/it/errors.json'

export const SUPPORTED_LANGUAGES = [
  { code: 'en', nativeLabel: 'English' },
  { code: 'de', nativeLabel: 'Deutsch' },
  { code: 'fr', nativeLabel: 'Français' },
  { code: 'es', nativeLabel: 'Español' },
  { code: 'it', nativeLabel: 'Italiano' },
] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]['code']

const SUPPORTED_CODES: readonly string[] = SUPPORTED_LANGUAGES.map((l) => l.code)
const FALLBACK: SupportedLanguage = 'en'

function isSupported(code: string): code is SupportedLanguage {
  return SUPPORTED_CODES.includes(code)
}

function readPersisted(): SupportedLanguage | null {
  const raw = getLocalePref()
  if (raw && isSupported(raw)) return raw
  return null
}

function readSystem(): SupportedLanguage {
  const sys = window.bridge?.getLocale?.() ?? FALLBACK
  const short = sys.toLowerCase().split('-')[0] ?? ''
  return isSupported(short) ? short : FALLBACK
}

function resolveInitialLocale(): SupportedLanguage {
  return readPersisted() ?? readSystem()
}

i18n.use(initReactI18next).init({
  lng: resolveInitialLocale(),
  fallbackLng: FALLBACK,
  defaultNS: 'common',
  ns: ['common', 'errors'],
  resources: {
    en: { common: enCommon, errors: enErrors },
    de: { common: deCommon, errors: deErrors },
    fr: { common: frCommon, errors: frErrors },
    es: { common: esCommon, errors: esErrors },
    it: { common: itCommon, errors: itErrors },
  },
  interpolation: { escapeValue: false },
  returnNull: false,
})

document.documentElement.lang = i18n.language

function pushTrayLabels(): void {
  window.bridge?.setTrayLabels?.({
    show: i18n.t('tray.show'),
    settings: i18n.t('tray.settings'),
    quit: i18n.t('tray.quit'),
    tooltip: i18n.t('tray.tooltip'),
  })
}

pushTrayLabels()
i18n.on('languageChanged', pushTrayLabels)

export function setLocale(code: SupportedLanguage): void {
  setLocalePref(code)
  i18n.changeLanguage(code)
  document.documentElement.lang = code
}

export default i18n
