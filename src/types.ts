import type { ComponentType } from 'preact'
import type { Context, Hono, MiddlewareHandler } from 'hono'

// ─── Logger ──────────────────────────────────────────────────

/**
 * Structured logger interface. The message is a short human-readable label
 * (stable, grep-able). Structured fields (requestId, route, durationMs, error,
 * etc.) are passed as a separate object so log pipelines can index them without
 * parsing free-text strings.
 *
 * The default logger is `console`, which passes fields as the second argument
 * to `console.info` / `console.warn` / `console.error`. For production, provide
 * a custom logger that serializes to JSON or your log pipeline's format.
 */
export interface Logger {
  info: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
  error: (message: string, fields?: Record<string, unknown>) => void
}

// ─── Render mode ──────────────────────────────────────────────

export type Mode = 'ssr' | 'csr'

/**
 * Render mode override.
 *   'auto' — detect per-request (TV → CSR, Web → SSR)
 *   'ssr'  — always server-render, even for TV clients
 *   'csr'  — always serve CSR shell, for all clients
 */
export type RenderMode = 'auto' | 'ssr' | 'csr'

// ─── Routes ───────────────────────────────────────────────────

export interface Route<TState = Record<string, unknown>> {
  path: string
  /**
   * Preact component that renders the page. Receives the data from getData
   * as props: `{ data: Partial<TState> }`. This is the only data-passing
   * mechanism during SSR — the component receives data directly, not via
   * side effects or module-level state. This is safe under concurrent
   * requests because each request's data is in its own props closure.
   */
  component: ComponentType<{ data: Partial<TState> }>
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
  /**
   * Side-effect hook fired before the component renders (analytics, tracking).
   *
   * Fire-and-forget: the engine does NOT await the return value. A sync throw or
   * a rejected promise is logged and isolated — it never breaks the render or
   * surfaces as an unhandled rejection. Because it is not awaited, a slow hook
   * does not delay the SSR response. On serverless runtimes the isolate may be
   * torn down once the response is flushed, so do not rely on async work
   * completing after the response — prefer sync hooks or kick work off
   * before returning.
   *
   * The `data` object is FROZEN (Object.freeze) before being passed to this
   * hook. Any attempt to mutate it will throw in strict mode (ESM default).
   * If you need to transform data, return a new object — do not mutate the
   * received reference, as it is the same object that will be serialized into
   * SSR __DATA__.
   *
   * This hook is for SIDE EFFECTS only. Data is passed to the component as
   * props (`{ data }`). Do not use beforeRender to set mutable state that the
   * component reads during render — that creates a race condition under
   * concurrent SSR requests on the same isolate.
   */
  beforeRender?: (data: Partial<TState>) => void | Promise<void>
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
  /**
   * Extra <head> content (fonts, meta tags, analytics). Default: empty.
   *
   * SECURITY: interpolated into the HTML <head> RAW (not escaped) — it must be
   * build-time, app-controlled content. Never interpolate user- or
   * request-derived values here, or it becomes an XSS vector.
   */
  headContent?: string
  tvPath?: string
  detectMode?: (req: Request) => Mode
  /** Render mode override. Default: 'auto' (per-request detection). */
  renderMode?: RenderMode
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
   * App-level freshness TTL for config cache, in milliseconds.
   *
   * When set, cached config is served instantly while fresh (within TTL).
   * When stale (past TTL), the stale value is served immediately and a
   * non-blocking background refresh fetches a new value from origin. The
   * next request after the refresh completes gets the fresh value.
   *
   * Default: undefined (no TTL, config cached until isolate restart or
   * manual reset()).
   */
  configTtl?: number
  /**
   * Max allowed size (bytes) for SSR __DATA__ on any single route.
   * When exceeded, the engine logs a warning (dev) or throws (production).
   * Default: 524288 (512KB). Set to Infinity to disable.
   */
  maxDataSize?: number

  /**
   * Development mode. When true, the engine warns on large `__DATA__` payloads
   * (over 100KB). Environment-agnostic — no process.env check. Default: false.
   */
  dev?: boolean

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
  /**
   * Security headers set on all responses.
   *
   * Default: { 'X-Content-Type-Options': 'nosniff' }.
   * Set to false to disable all security headers.
   * Provide a record to merge with defaults — use an empty string value
   * to remove a specific default header.
   */
  securityHeaders?: false | Record<string, string>
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
   * URL the client can fetch to re-hydrate data if SSR HTML is discarded.
   * Example: '/api/data/show/42'
   * Set by the engine automatically.
   */
  ssrDataUrl?: string
  /**
   * Max allowed __DATA__ size in bytes.
   * - When exceeded: logs a warning if `dev` is true, throws if `maxDataSize`
   *   is also exceeded.
   * Omit for unlimited.
   */
  maxDataSize?: number
  /**
   * Development mode. When true, the engine warns on large `__DATA__` payloads
   * (over 100KB). This replaces a `process.env.NODE_ENV` check so the engine
   * stays environment-agnostic. Default: false (no warning).
   */
  dev?: boolean
}

export interface CsrShellOpts {
  cssPath: string
  jsPath: string
  title?: string
  headContent?: string
}

// ─── Hono app types ──────────────────────────────────────────

export type AppEnv = { Variables: { requestId: string } }
export type HonoApp = Hono<AppEnv>

// ─── Route matching ───────────────────────────────────────────

export interface MatchedRoute {
  route: Route
  params: Record<string, string>
}

