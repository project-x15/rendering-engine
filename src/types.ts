import type { ComponentType } from 'preact'
import type { Context, MiddlewareHandler } from 'hono'

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
   */
  getData?: (ctx: RequestContext) => Promise<Partial<TState>> | Partial<TState>
  beforeRender?: (data: Partial<TState>) => void
  onError?: (err: Error) => Partial<TState>
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
   * into SSR __DATA__. Pluck only what the page needs:
   *
   *   getData: (ctx) => ({ theme: ctx.config.theme })
   *
   * Returning the full ctx.config from getData embeds megabytes into HTML.
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
  /** Global config fetcher. Result is cached and passed to every getData via ctx.config. */
  configLoader?: () => Promise<Record<string, unknown>>
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
   * Max allowed size (bytes) for SSR __DATA__ on any single route.
   * When exceeded, the engine logs a warning (dev) or throws (production).
   * Default: unlimited.
   */
  maxDataSize?: number

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

