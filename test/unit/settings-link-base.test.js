import test from 'brittle'
import { coerceSettings, defaultSettings } from '../../src/shared/core/settings-rules.js'
import { DEFAULT_WEB_LINK_BASE } from '../../src/shared/contract/invite-envelope.js'

const deps = { sanitizeRelay: () => null, recentLimit: 3 }
const base = (baseUrl) => coerceSettings({ links: { baseUrl } }, deps).links.baseUrl

test('the link base defaults to the Mirall links host', (t) => {
  t.is(defaultSettings().links.baseUrl, DEFAULT_WEB_LINK_BASE)
  t.is(coerceSettings({}, deps).links.baseUrl, DEFAULT_WEB_LINK_BASE)
  t.is(coerceSettings({ links: 'x' }, deps).links.baseUrl, DEFAULT_WEB_LINK_BASE)
})

test('a self-hosted base keeps its path and loses trailing slashes', (t) => {
  t.is(base('https://console.example/link'), 'https://console.example/link')
  t.is(base('https://console.example/link/'), 'https://console.example/link')
  t.is(base('https://link.example'), 'https://link.example')
})

test('anything but a bare https URL falls back to the default', (t) => {
  for (const bad of ['http://console.example/link', 'console.example/link', '', 'https://x/link?x=1', 'https://x/link#frag', 'https://x/link?', 'https://x/link#', 42, null]) {
    t.is(base(bad), DEFAULT_WEB_LINK_BASE, String(bad))
  }
})
