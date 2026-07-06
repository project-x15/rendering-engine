import type { Mode } from './types.js'

const TV_UA_KEYWORDS = [
  'tv', 'smarttv', 'smart-tv', 'smart_tv',
  'webos', 'netcast',
  'tizen',
  'roku', 'aftt', 'aftb', 'aftm',
  'appletv', 'apple tv', 'applecoremedia',
  'hbbtv', 'viera', 'bravia',
  'googletv',
  'espial', 'nettv',
  'opera tv',
] as const

/**
 * Multi-signal detection (priority order):
 * 1. Query param (?tv=1 / ?web=1)
 * 2. Cookie (tv-mode=1 / tv-mode=0)
 * 3. Sec-CH-UA-Platform client hint
 * 4. User-Agent keyword match
 *
 * Default: 'ssr'. TV UAs → 'csr'.
 */
export function detectMode(req: Request): Mode {
  const url = new URL(req.url)

  // 1. Query param override
  if (url.searchParams.get('tv') === '1') return 'csr'
  if (url.searchParams.get('web') === '1') return 'ssr'

  // 2. Cookie override
  const cookie = req.headers.get('cookie') ?? ''
  if (/tv-mode=1/.test(cookie)) return 'csr'
  if (/tv-mode=0/.test(cookie)) return 'ssr'

  // 3. Client hints
  const secChUa = req.headers.get('sec-ch-ua-platform') ?? ''
  if (/tv|television/i.test(secChUa)) return 'csr'

  // 4. User-Agent keyword match
  const ua = (req.headers.get('user-agent') ?? '').toLowerCase()
  for (let i = 0; i < TV_UA_KEYWORDS.length; i++) {
    if (ua.indexOf(TV_UA_KEYWORDS[i]) !== -1) return 'csr'
  }

  return 'ssr'
}