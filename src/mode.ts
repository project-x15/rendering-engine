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
 * Parse a single cookie value from the Cookie header by exact name match.
 * Splits on '; ' (the standard cookie separator) and matches the key
 * exactly, so 'not-tv-mode' does not match 'tv-mode'.
 * Returns the decoded value or null if the cookie is absent.
 */
function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  const parts = header.split(';')
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=')
    if (eq === -1) continue
    const key = parts[i].slice(0, eq).trim()
    if (key === name) {
      const val = parts[i].slice(eq + 1).trim()
      try {
        return decodeURIComponent(val)
      } catch {
        return val
      }
    }
  }
  return null
}

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

  // 2. Cookie override — parse cookie header properly to avoid
  // matching substrings (e.g. 'not-tv-mode=1' must not match 'tv-mode=1').
  const cookieValue = getCookie(req, 'tv-mode')
  if (cookieValue === '1') return 'csr'
  if (cookieValue === '0') return 'ssr'

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