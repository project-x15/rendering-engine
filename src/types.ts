import type { ComponentType } from 'preact'
import type { Context, MiddlewareHandler } from 'hono'

// ─── Logger ──────────────────────────────────────────────────

export interface Logger {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

// ─── Render mode ──────────────────────────────────────────────

export type Mode = 'ssr' | 'csr'

// ─── Routes ───────────────────────────────────────────────────

export interface Route<TState = Record<string, unknown>> {
  path: string
  component: ComponentType<Record<string, unknown>>
  /**
   * Fetch page-specific data for this route.
   *
   * Return ONLY the data this page needs to render. The return value is
   * serialized into SSR `__DATA__` and sent to the client. Large payloads
   * bloat every SSR response.
   *
   * Global config (theme, features, catalog) is available on `ctx.config`
   * but is NOT automatically inlined. If you need a config value on the
   * client, pluck it explicitly:
   *
   *   getData: (ctx) => ({ theme: ctx.config.theme })
   *
   * Do NOT return the full ctx.config — that embeds megabytes into HTML.
   * See `config` on RequestContext for details.
   */
  getData?: (ctx: RequestContext) => Promise<Partial<TState>> | Partial<TState>
  beforeRender?: (data: Partial<TState>) => void
  onError?: (err: Error) => Partial<TState>
  /**
   * Optional validator for extracted route params.
   * Called after params are decoded. Return false to treat the route as
   * no-match (falls through to next route).
   *
   *   validateParams: (p) => /^\d+$/.test(p.id)
   */
  validateParams?: (params: Record<string, string>) => boolean
}

// ─── Request context ──────────────────────────────────────────

export interface RequestContext {
  params: Record<string, string>
  request: Request
  mode: Mode
  /** App-specific environment (API keys, URLs, feature flags) */
  env: Record<string, unknown>
  /**
   * Cached global config from configLoader (theme, features, etc.).
   *
   * Available in getData/beforeRender/onError. NOT automatically inlined
   * into SSR __DATA__. Pluck only what the page needs — see getData docs.
   */
  config: Record<string, unknown>
}

// ─── Engine options ───────────────────────────────────────────

export interface AppOptions {
  routes: Route[]
  assetsRoot?: string
  webCssPath?: string
  webJsPath?: string
  tvCssPath?: string
  tvJsPath?: string
  /** HTML <title>. Default: app must provide. */
  title?: string
  /** Extra <head> content (fonts, meta tags, analytics). Default: empty. */
  headContent?: string
  tvPath?: string
  detectMode?: (req: Request) => Mode
  /** Resolve app-specific env from the request (API keys, headers, etc.) */
  getEnv?: (c: Context) => Record<string, unknown>
  /**
   * Global config fetcher. Result is cached and passed to every getData via ctx.config.
   * Receives an optional AbortSignal — use it to cancel long-running fetches when
   * configTimeout fires. If ignored, the engine still rejects via race, but the
   * underlying request keeps running.
   */
  configLoader?: (signal?: AbortSignal) => Promise<Record<string, unknown>>
  /**
   * Optional selector to filter which config keys /api/config exposes to TV clients.
   * `ctx.config` in getData still gets the full config (unchanged).
   * Only the /api/config endpoint uses the selector.
   * No selector → returns full config (backward compat).
   */
  configSelector?: (config: Record<string, unknown>) => Record<string, unknown>
  /**
   * Hard cap on config size in bytes.
   * If fetched config exceeds this, load() rejects with a size error.
   * App degrades to {} config gracefully (existing path).
   * Default: no limit.
   */
  maxConfigSize?: number
  /**
   * Timeout in ms for the config fetcher.
   * If Contentful is slow, fail fast. Next request retries.
   * Default: no timeout.
   */
  configTimeout?: number
  /**
   * Circuit breaker cooldown in ms after a config fetch failure.
   * During cooldown, stale L2 cache is served if available.
   * Set to 0 to disable (immediate retry on every request).
   * Default: 5000 (5 seconds).
   */
  circuitBreakerCooldownMs?: number
  /**
   * Max allowed size (bytes) for SSR __DATA__ on any single route.
   * When exceeded, the engine logs a warning (dev) or throws (production).
   * Default: 524288 (512KB). Set to Infinity to disable.
   */
  maxDataSize?: number

  /**
   * Logger for engine-internal diagnostics.
   * Defaults to console if not provided.
   */
  logger?: Logger
  /**
   * Cache-Control header value for SSR responses.
   * Not set by default. Example: 'public, max-age=60, stale-while-revalidate=30'
   */
  cacheControl?: string

  /** Static asset middleware. Omit on Workers (wrangler handles assets). */
  serveStatic?: (opts: { root: string }) => MiddlewareHandler
}

// ─── HTML template options ────────────────────────────────────

export interface SsrTemplateOpts {
  html: string
  data: unknown
  cssPath: string
  jsPath: string
  title?: string
  headContent?: string
  /** Route path for warning messages (e.g. '/show/:id') */
  routePath?: string
  /**
   * Max allowed __DATA__ size in bytes.
   * - In development: logs warning when exceeded
   * - In production: throws when exceeded
   * Omit for unlimited.
   */
  maxDataSize?: number
}

export interface CsrShellOpts {
  cssPath: string
  jsPath: string
  title?: string
  headContent?: string
}

// ─── Route matching ───────────────────────────────────────────

export interface MatchedRoute {
  route: Route
  params: Record<string, string>
}

