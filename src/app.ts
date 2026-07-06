import { h } from 'preact'
import { Hono } from 'hono'
import { renderToString } from 'preact-render-to-string'
import { detectMode } from './mode.js'
import { matchRoute } from './router.js'
import { ssrTemplate, csrShell } from './html.js'
import { createConfigLoader, type ConfigLoader } from './config.js'
import type { AppOptions, Mode, Route, RequestContext } from './types.js'
import type { Context } from 'hono'

type HonoApp = InstanceType<typeof Hono>

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
  const app = new Hono()
  const { routes } = options
  const assetsRoot = options.assetsRoot ?? './dist'
  const _detect = options.detectMode ?? detectMode
  const title = options.title ?? ''
  const tvPath = options.tvPath ?? '/tv'
  const headContent = options.headContent ?? ''

  const webCss = options.webCssPath ?? '/web/assets/style.css'
  const webJs = options.webJsPath ?? '/web/assets/client.js'
  const tvCss = options.tvCssPath ?? '/tv/assets/style.css'
  const tvJs = options.tvJsPath ?? '/tv/assets/app.js'
  const maxDataSize = options.maxDataSize

  // Config loader with cache (persists across requests on same isolate/process)
  const config: ConfigLoader<Record<string, unknown>> | null = options.configLoader
    ? createConfigLoader(options.configLoader)
    : null

  function resolveEnv(c: Context): Record<string, unknown> {
    return options.getEnv ? options.getEnv(c) : {}
  }

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
      return config.load()
        .then((cfg) => c.json(cfg))
        .catch((err: Error) => c.json({ error: err.message }, 500))
    })
  }

  // ── /api/data/* — page data endpoint for TV CSR ──
  app.get('/api/data/*', (c) => {
    const pathname = c.req.path.replace('/api/data', '') || '/'
    const matched = matchRoute(routes, pathname)
    if (!matched) {
      return c.json({ error: 'Not found' }, 404)
    }

    const env = resolveEnv(c)
    const configPromise = config ? config.load() : Promise.resolve({})

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
        return getData ? Promise.resolve(getData(ctx)) : Promise.resolve({})
      })
      .then((data) => c.json(data))
      .catch((err: Error) => c.json({ error: err.message }, 500))
  })

  // ── Page routes ──
  for (const route of routes) {
    app.get(route.path, (c) => {
      if (_detect(c.req.raw) === 'csr') {
        return c.html(csrShell({ cssPath: tvCss, jsPath: tvJs, title, headContent }))
      }

      const env = resolveEnv(c)
      const configPromise = config ? config.load() : Promise.resolve({})

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
          return getData ? Promise.resolve(getData(ctx)) : Promise.resolve({})
        })
        .then((data) => {
          if (route.beforeRender) route.beforeRender(data)
          const html = renderToString(h(route.component, null))
          return c.html(ssrTemplate({ html, data, cssPath: webCss, jsPath: webJs, title, headContent, routePath: route.path, maxDataSize }))
        })
        .catch((err: Error) => {
          const errorData = route.onError ? route.onError(err) : { error: err.message }
          if (route.beforeRender) route.beforeRender(errorData)
          const html = renderToString(h(route.component, null))
          return c.html(ssrTemplate({ html, data: errorData, cssPath: webCss, jsPath: webJs, title, headContent, routePath: route.path, maxDataSize }))
        })
    })
  }

  return app
}