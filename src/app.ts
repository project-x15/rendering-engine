import { h } from 'preact'
import { Hono } from 'hono'
import { renderToString } from 'preact-render-to-string'
import { detectMode } from './mode.js'
import { ssrTemplate, csrShell } from './html.js'
import { createConfigLoader, type ConfigLoader } from './config.js'
import { registerRequestId, registerStaticAssets, registerTvShell } from './builders.js'
import type { AppOptions, AppEnv, HonoApp, Logger, Mode, Route, RequestContext } from './types.js'
import type { Context } from 'hono'

/**
 * Create a dual-mode rendering app.
 *
 * Handles:
 *   - Mode detection (TV -> CSR shell, Web -> SSR)
 *   - SSR rendering with __DATA__ serialization
 *   - TV CSR shell serving
 *   - /api/data/* endpoint (TV client fetches page data)
 *   - /api/config endpoint (TV client fetches global config)
 *   - Static asset serving (when serveStatic option is provided)
 *   - Global config loading with cache + dedup
 *   - Error handling (onError fallback)
 */
export function createApp(options: AppOptions): HonoApp {
  const app = new Hono<AppEnv>()
  const { routes } = options
  const assetsRoot = options.assetsRoot ?? './dist'
  const modeDetector = options.detectMode ?? detectMode
  const renderMode = options.renderMode ?? 'auto'
  const title = options.title ?? ''
  const tvPath = options.tvPath ?? '/tv'
  const headContent = options.headContent ?? ''
  const logger: Logger = options.logger ?? console
  const cacheControl = options.cacheControl
  const dev = options.dev ?? false

  const webCss = options.webCssPath ?? '/web/assets/style.css'
  const webJs = options.webJsPath ?? '/web/assets/client.js'
  const tvCss = options.tvCssPath ?? '/tv/assets/style.css'
  const tvJs = options.tvJsPath ?? '/tv/assets/app.js'
  // Default 512KB — catches accidental config leaks without breaking
  // legitimate large page data. Set to Infinity to disable.
  const maxDataSize = options.maxDataSize ?? 524_288

  // Config loader with cache (persists across requests on same isolate/process)
  const config: ConfigLoader<Record<string, unknown>> | null = options.configLoader
    ? createConfigLoader(options.configLoader, {
        maxConfigSize: options.maxConfigSize,
        configTimeout: options.configTimeout,
        circuitBreakerCooldownMs: options.circuitBreakerCooldownMs,
        configTtl: options.configTtl,
        logger,
      })
    : null

  function resolveEnv(c: Context): Record<string, unknown> {
    return options.getEnv ? options.getEnv(c) : {}
  }

  // Load config with graceful degradation: a failed load must not take down
  // the request, but it also must not be hidden. Degrade to an empty config
  // and log the failure with context (per Logging Rules) so the missing
  // config is observable in production instead of silently swallowed.
  async function loadConfig(rid: string, phase: string): Promise<Record<string, unknown>> {
    if (!config) return {}
    try {
      return await config.load()
    } catch (err: any) {
      logger.warn('[x15/engine] config: load failed', { requestId: rid, phase, error: err })
      return {}
    }
  }

  // beforeRender is a side-effect hook (analytics, tracking): fire-and-forget.
  // It may be sync or async. A failure — sync throw or a rejected promise —
  // must never break the render or surface as an unhandled rejection. The
  // hook is NOT awaited, so a slow hook cannot delay the SSR response.
  //
  // The data object is frozen before passing to the hook so mutations in
  // beforeRender cannot silently corrupt the __DATA__ payload. If the hook
  // needs to transform data, it must return a new object — not mutate the
  // received reference.
  function fireAndForgetBeforeRender(
    route: Route,
    rid: string,
    hookData: Partial<unknown>,
    phase: string,
  ): void {
    if (!route.beforeRender) return
    try {
      const result = route.beforeRender(Object.freeze(hookData)) as unknown
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch((e) => {
          logger.warn('[x15/engine] beforeRender failed', { requestId: rid, route: route.path, phase, error: e })
        })
      }
    } catch (e) {
      logger.warn('[x15/engine] beforeRender failed', { requestId: rid, route: route.path, phase, error: e })
    }
  }

  // ── Request ID middleware — propagate or generate x-request-id ──
  registerRequestId(app)

  // ── Security headers middleware — set on all responses ──
  const securityHeaders = options.securityHeaders === false
    ? null
    : { 'X-Content-Type-Options': 'nosniff', ...options.securityHeaders }
  if (securityHeaders) {
    app.use('*', async (c, next) => {
      await next()
      for (const [key, value] of Object.entries(securityHeaders)) {
        if (value) c.header(key, value)
      }
    })
  }

  // Optional: Workers uses wrangler for assets, so serveStatic is omitted there
  registerStaticAssets(app, options.serveStatic, assetsRoot)

  // ── Direct TV access ──
  registerTvShell(app, { tvPath, tvCss, tvJs, title, headContent })

  // ── /api/config — cached global config for TV CSR ──
  if (config) {
    app.get('/api/config', async (c) => {
      const start = performance.now()
      const rid = c.get('requestId') as string
      try {
        const cfg = await config.load()
        logger.info('[x15/engine] /api/config served', { requestId: rid, durationMs: performance.now() - start })
        // Apply configSelector if provided — TV clients get trimmed payload
        const selected = options.configSelector ? options.configSelector(cfg) : cfg
        return c.json(selected)
      } catch (err: any) {
        logger.error('[x15/engine] /api/config failed', { requestId: rid, error: err })
        return c.json({ error: err.message }, 500)
      }
    })
  }

  // ── /api/data/* — page data endpoint for TV CSR ──
  //
  // Each route is registered as /api/data{route.path} on Hono's router
  // (O(1) matching via SmartRouter/RegExpRouter) instead of a single
  // /api/data/* wildcard with a linear-scan matchRoute. This eliminates
  // the dual routing system — one router for both page and data routes.
  //
  // The catch-all /api/data/* (registered after all specific routes) returns
  // 404 for unknown paths.
  function createDataHandler(route: Route) {
    return async (c: Context) => {
      const start = performance.now()
      const rid = c.get('requestId') as string
      const params = c.req.param() ?? {}

      // validateParams: reject malformed params (treat as 404, same as
      // the old matchRoute behavior where validation failure = no match).
      if (route.validateParams && !route.validateParams(params)) {
        return c.json({ error: 'Not found' }, 404)
      }

      const env = resolveEnv(c)
      const cfg = await loadConfig(rid, 'serving data without config')

      try {
        const ctx: RequestContext = {
          params,
          request: c.req.raw,
          mode: 'csr' as Mode,
          env,
          config: cfg,
        }
        const getData = route.getData
        const data = getData ? await getData(ctx) : {}

        // Guard: detect if getData returned the full config object reference.
        // Catches the common mistake: getData: (ctx) => ctx.config
        // Does not catch spread ({ ...ctx.config }) — maxDataSize handles that.
        if (data === cfg) {
          throw new Error(
            `[x15/engine] getData for route "${route.path}" returned the full config object. ` +
            `This embeds megabytes into every API response. ` +
            `Return only the config values the page needs.`
          )
        }
        const pathname = c.req.path.slice('/api/data'.length) || '/'
        logger.info('[x15/engine] /api/data served', { requestId: rid, path: pathname, durationMs: performance.now() - start })
        return c.json(data)
      } catch (err: any) {
        const pathname = c.req.path.slice('/api/data'.length) || '/'
        logger.error('[x15/engine] /api/data failed', { requestId: rid, path: pathname, error: err })
        return c.json({ error: err.message }, 500)
      }
    }
  }

  // ── Page routes + data routes ──
  for (const route of routes) {
    // Data route: register on Hono's router (replaces /api/data/* wildcard)
    const dataPath = '/api/data' + route.path
    app.get(dataPath, createDataHandler(route))
    // Root route also needs /api/data without trailing slash — Hono does not
    // normalize trailing slashes by default, so /api/data and /api/data/ are
    // different routes. Both must resolve to the root route's data.
    if (route.path === '/') {
      app.get('/api/data', createDataHandler(route))
    }

    // Page route — mode detection + SSR
    app.get(route.path, async (c) => {
      const mode = renderMode === 'auto' ? modeDetector(c.req.raw) : renderMode
      if (mode === 'csr') {
        return c.html(csrShell({ cssPath: tvCss, jsPath: tvJs, title, headContent }))
      }

      const start = performance.now()
      const rid = c.get('requestId') as string
      const env = resolveEnv(c)
      const cfg = await loadConfig(rid, 'rendering without config')

      try {
        const ctx: RequestContext = {
          params: c.req.param() ?? {},
          request: c.req.raw,
          mode: 'ssr' as Mode,
          env,
          config: cfg,
        }
        const getData = route.getData
        const data = getData ? await getData(ctx) : {}

        // Guard: detect if getData returned the full config object reference.
        // Catches the common mistake: getData: (ctx) => ctx.config
        // Does not catch spread ({ ...ctx.config }) — maxDataSize handles that.
        if (data === cfg) {
          throw new Error(
            `[x15/engine] getData for route "${route.path}" returned the full config object. ` +
            `This embeds megabytes into every SSR response. ` +
            `Return only the config values the page needs, e.g. { theme: ctx.config.theme }.`
          )
        }
        fireAndForgetBeforeRender(route, rid, data, '')
        const html = renderToString(h(route.component, { data }))
        // SSR data URL: tells client JS where to re-fetch data if it
        // discards the server-rendered HTML. Client reads #app[data-ssr-url]
        // and calls fetch() to get fresh __DATA__-equivalent JSON.
        const ssrDataUrl = '/api/data' + c.req.path
        const res = c.html(ssrTemplate({ html, data, cssPath: webCss, jsPath: webJs, title, headContent, routePath: route.path, maxDataSize, ssrDataUrl, dev }))
        if (cacheControl) res.headers.set('Cache-Control', cacheControl)
        logger.info('[x15/engine] SSR completed', { requestId: rid, route: route.path, durationMs: performance.now() - start })
        return res
      } catch (err: any) {
        // Error path: render with fallback data.
        // Wrap in try/catch because renderToString can throw even in the
        // error path. If it does, produce a minimal fallback HTML instead
        // of an unhandled exception.
        try {
          const errorData = route.onError ? route.onError(err) : { error: err.message }
          fireAndForgetBeforeRender(route, rid, errorData, ' in error path')
          const html = renderToString(h(route.component, { data: errorData }))
          const ssrDataUrl = '/api/data' + c.req.path
          const res = c.html(ssrTemplate({ html, data: errorData, cssPath: webCss, jsPath: webJs, title, headContent, routePath: route.path, maxDataSize, ssrDataUrl, dev }))
          if (cacheControl) res.headers.set('Cache-Control', cacheControl)
          logger.info('[x15/engine] SSR completed (error fallback)', { requestId: rid, route: route.path, durationMs: performance.now() - start })
          return res
        } catch (renderErr: any) {
          // Final fallback: renderToString failed in the error path.
          // Produce a minimal HTML page so the client gets something.
          const msg = renderErr instanceof Error ? renderErr.message : String(renderErr)
          logger.error('[x15/engine] SSR error fallback also failed', { requestId: rid, route: route.path, error: renderErr })
          const fallbackHtml = ssrTemplate({
            html: '<p>Render error</p>',
            data: { error: msg },
            cssPath: webCss,
            jsPath: webJs,
            title,
            headContent,
            routePath: route.path,
            maxDataSize,
            ssrDataUrl: '/api/data' + c.req.path,
            dev,
          })
          const res = c.html(fallbackHtml, 500)
          if (cacheControl) res.headers.set('Cache-Control', cacheControl)
          return res
        }
      }
    })
  }

  // Catch-all for unknown /api/data paths (must be after specific routes
  // so Hono's router matches specific routes first).
  app.get('/api/data/*', (c) => c.json({ error: 'Not found' }, 404))

  return app
}