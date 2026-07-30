import type { Logger } from '../src/types.js'

// ── Logger capture ──────────────────────────────────────────────────────

export type CapturedLog = { level: string; message: string; fields?: Record<string, unknown> }

/**
 * Capture console.warn calls. Returns captured messages and a restore function.
 */
export function captureWarn(): { messages: unknown[][]; restore: () => void } {
  const messages: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { messages.push(args) }
  return { messages, restore: () => { console.warn = original } }
}

/**
 * Capture console.warn as strings. Returns captured messages and a restore function.
 */
export function captureConsoleWarn(): { messages: string[]; restore: () => void } {
  const messages: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { messages.push(String(args[0])); original(...args) }
  return { messages, restore: () => { console.warn = original } }
}

/**
 * Create a structured logger that captures all calls into a log array.
 */
export function captureLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = []
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields }),
  }
  return { logger, logs }
}

// ── __DATA__ extraction ────────────────────────────────────────────────

/**
 * Extract and parse the __DATA__ JSON from an SSR HTML string.
 * Returns the parsed data as unknown.
 */
export function extractDataJson(html: string): unknown {
  const m = html.match(/<script id="__DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (!m) throw new Error('no __DATA__ in HTML')
  return JSON.parse(m[1].replace(/<\\\/script>/g, '</script>'))
}

/**
 * Extract and parse the __DATA__ JSON from an SSR HTML string.
 * Returns the parsed data as a Record.
 */
export function extractData(html: string): Record<string, unknown> {
  return extractDataJson(html) as Record<string, unknown>
}

// ── Cache API mock ─────────────────────────────────────────────────────

/**
 * Mock the Cache API (caches.default) for testing L2 cache behavior.
 * Returns a cleanup function that restores the global and clears the store.
 */
export function mockCacheApi(): { cleanup: () => void } {
  const store = new Map<string, Response>()
  ;(globalThis as any).caches = {
    default: {
      match: (key: string) => {
        const val = store.get(key)
        if (!val) return Promise.resolve(undefined)
        return Promise.resolve(val.clone())
      },
      put: (key: string, res: Response) => {
        store.set(key, res)
        return Promise.resolve()
      },
    },
  }
  return {
    cleanup: () => { delete (globalThis as any).caches; store.clear() },
  }
}
