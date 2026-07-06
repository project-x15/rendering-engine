import { h } from 'preact'
import { Hono } from 'hono'
import { renderToString } from 'preact-render-to-string'
import { detectMode } from './mode.js'
import { matchRoute } from './router.js'
import { ssrTemplate, csrShell } from './html.js'
import { createConfigLoader, type ConfigLoader } from './config.js'
import type { AppOptions, Logger, Mode, Route, RequestContext } from './types.js'
import type { Context } from 'hono'

type AppEnv = { Variables: { requestId: string } }
type HonoApp = Hono<AppEnv>

/**
 * Create a dual-mode rendering app.
 *
 * Handles:
 *   - Mode detection (TV → CSR shell, Web → SSR)
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
  const title = options.title ?? ''
  const tvPath = options.tvPath ?? '/tv'
  const headContent = options.headContent ?? ''
  const logger: Logger = options.logger ?? console
  const cacheControl = options.cacheControl

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
        logger,
      })
    : null

  function resolveEnv(c: Context): Record<string, unknown> {
    return options.getEnv ? options.getEnv(c) : {}
  }

  // ── Request ID middleware — propagate or generate x-request-id ──
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    c.set('requestId', requestId)
    await next()
    c.header('x-request-id', requestId)
  })

  // Optional: Workers uses wrangler for assets, so serveStatic is omitted there
  const serveStatic = options.serveStatic
  if (serveStatic) {
    app.get('/tv/assets/*', serveStatic({ root: assetsRoot }))
    app.get('/web/assets/*', serveStatic({ root: assetsRoot }))
  }

  // ── Direct TV access ──
  app.get(tvPath, (c) => {
    return c.html(csrShell({ cssPath: tvCss, jsPath: tvJs, title, headContent }))
  })

  // ── /api/config — cached global config for TV CSR ──
  if (config) {
    app.get('/api/config', (c) => {
      const start = performance.now()
      const rid = c.get('requestId') as string
      return config.load()
        .then((cfg) => {
          logger.info(`[x15/engine] ${rid} /api/config served in ${(performance.now() - start).toFixed(1)}ms`)
          // Apply configSelector if provided — TV clients get trimmed payload
          const selected = options.configSelector ? options.configSelector(cfg) : cfg
          return c.json(selected)
        })
        .catch((err: Error) => {
          logger.error(`[x15/engine] ${rid} /api/config failed`, err)
          return c.json({ error: err.message }, 500)
        })
    })
  }

  // ── /api/data/* — page data endpoint for TV CSR ──
  app.get('/api/data/*', (c) => {
    const start = performance.now()
    const rid = c.get('requestId') as string
    const pathname = c.req.path.replace('/api/data', '') || '/'
    const matched = matchRoute(routes, pathname)
    if (!matched) {
      return c.json({ error: 'Not found' }, 404)
    }

    const env = resolveEnv(c)
    // Config is optional data — a failed load must not take down the data
    // chain, but it also must not be hidden. Degrade to an empty config and
    // log the failure with context (per Logging Rules). The /api/config
    // endpoint still surfaces the error to TV clients; here we degrade.
    const configPromise = config
      ? config.load().catch((err: Error) => {
          logger.warn(`[x15/engine] ${rid} config: load failed, serving data without config`, err)
          return {}
        })
      : Promise.resolve({})

    return configPromise
      .then((cfg) => {
        const ctx: RequestContext = {
          params: matched.params,
          request: c.req.raw,
          mode: 'csr' as Mode,
          env,
          config: cfg,
        }
        const getData = matched.route.getData
        const dataPromise = getData ? Promise.resolve(getData(ctx)) : Promise.resolve({})
        return dataPromise.then((data) => ({ data, cfg }))
      })
      .then(({ data, cfg }) => {
        // Guard: detect if getData returned the full config object reference.
        // Catches the common mistake: getData: (ctx) => ctx.config
        // Does not catch spread ({ ...ctx.config }) — maxDataSize handles that.
        if (data === cfg) {
          throw new Error(
            `[x15/engine] getData for route "${matched.route.path}" returned the full config object. ` +
            `This embeds megabytes into every API response. ` +
            `Return only the config values the page needs.`
          )
        }
        logger.info(`[x15/engine] ${rid} /api/data${pathname} served in ${(performance.now() - start).toFixed(1)}ms`)
        return c.json(data)
      })
      .catch((err: Error) => {
        logger.error(`[x15/engine] ${rid} /api/data${pathname} failed`, err)
        return c.json({ error: err.message }, 500)
      })
  })

  // ── Page routes ──
  for (const route of routes) {
    app.get(route.path, (c) => {
      if (modeDetector(c.req.raw) === 'csr') {
        return c.html(csrShell({ cssPath: tvCss, jsPath: tvJs, title, headContent }))
      }

      const start = performance.now()
      const rid = c.get('requestId') as string
      const env = resolveEnv(c)
      // Config is optional data — a failed load must not take down the SSR
      // chain (e.g. cold-start IPv6 DNS race against the config server), but
      // it also must not be hidden. Degrade to an empty config and log the
      // failure with context (per Logging Rules) so the missing config is
      // observable in production instead of silently swallowed.
      const configPromise = config
        ? config.load().catch((err: Error) => {
            logger.warn(`[x15/engine] ${rid} config: load failed, rendering without config`, err)
            return {}
          })
        : Promise.resolve({})

      return configPromise
        .then((cfg) => {
          const ctx: RequestContext = {
            params: c.req.param() ?? {},
            request: c.req.raw,
            mode: 'ssr' as Mode,
            env,
            config: cfg,
          }
          const getData = route.getData
          const dataPromise = getData ? Promise.resolve(getData(ctx)) : Promise.resolve({})
          return dataPromise.then((data) => ({ data, cfg }))
        })
        .then(({ data, cfg }) => {
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
          // beforeRender is a side-effect hook (analytics, tracking). A failure
          // here must not kill the render — log and continue.
          if (route.beforeRender) {
            try {
              route.beforeRender(data)
            } catch (e) {
              logger.warn(`[x15/engine] ${rid} beforeRender failed for ${route.path}`, e)
            }
          }
          const html = renderToString(h(route.component, null))
          const res = c.html(ssrTemplate({ html, data, cssPath: webCss, jsPath: webJs, title, headContent, routePath: route.path, maxDataSize }))
          if (cacheControl) res.headers.set('Cache-Control', cacheControl)
          logger.info(`[x15/engine] ${rid} SSR ${route.path} completed in ${(performance.now() - start).toFixed(1)}ms`)
          return res
        })
        .catch((err: Error) => {
          // Error path: render with fallback data.
          // Wrap in try/catch because renderToString can throw even in the
          // error path. If it does, produce a minimal fallback HTML instead
          // of an unhandled exception.
          try {
            const errorData = route.onError ? route.onError(err) : { error: err.message }
            // beforeRender in error path — same isolation as main path.
            if (route.beforeRender) {
              try {
                route.beforeRender(errorData)
              } catch (e) {
                logger.warn(`[x15/engine] ${rid} beforeRender failed in error path for ${route.path}`, e)
              }
            }
            const html = renderToString(h(route.component, null))
            const res = c.html(ssrTemplate({ html, data: errorData, cssPath: webCss, jsPath: webJs, title, headContent, routePath: route.path, maxDataSize }))
            if (cacheControl) res.headers.set('Cache-Control', cacheControl)
            logger.info(`[x15/engine] ${rid} SSR ${route.path} (error fallback) completed in ${(performance.now() - start).toFixed(1)}ms`)
            return res
          } catch (renderErr) {
            // Final fallback: renderToString failed in the error path.
            // Produce a minimal HTML page so the client gets something.
            const msg = renderErr instanceof Error ? renderErr.message : String(renderErr)
            logger.error(`[x15/engine] ${rid} SSR ${route.path} error fallback also failed`, renderErr)
            const fallbackHtml = ssrTemplate({
              html: '<p>Render error</p>',
              data: { error: msg },
              cssPath: webCss,
              jsPath: webJs,
              title,
              headContent,
              routePath: route.path,
              maxDataSize,
            })
            const res = c.html(fallbackHtml, 500)
            if (cacheControl) res.headers.set('Cache-Control', cacheControl)
            return res
          }
        })
    })
  }

  return app
}