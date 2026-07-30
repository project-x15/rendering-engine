import { csrShell } from './html.js'
import type { MiddlewareHandler } from 'hono'
import type { HonoApp } from './types.js'

/**
 * Register request ID middleware.
 *
 * Propagates or generates an x-request-id header on every request.
 * No shared state with the rest of the app — safe to call independently.
 */
export function registerRequestId(app: HonoApp): void {
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    c.set('requestId', requestId)
    await next()
    c.header('x-request-id', requestId)
  })
}

/**
 * Register static asset routes.
 *
 * Optional: Workers uses wrangler for assets, so serveStatic is omitted there.
 * When serveStatic is not provided, this is a no-op.
 */
export function registerStaticAssets(
  app: HonoApp,
  serveStatic: ((opts: { root: string }) => MiddlewareHandler) | undefined,
  assetsRoot: string,
): void {
  if (!serveStatic) return
  app.get('/tv/assets/*', serveStatic({ root: assetsRoot }))
  app.get('/web/assets/*', serveStatic({ root: assetsRoot }))
}

/**
 * Register the TV CSR shell endpoint.
 *
 * Serves the CSR shell HTML at the configured tvPath (default: /tv).
 * The TV client bootstraps from this shell and fetches page data via
 * /api/data/*.
 */
export function registerTvShell(
  app: HonoApp,
  options: {
    tvPath: string
    tvCss: string
    tvJs: string
    title: string
    headContent: string
  },
): void {
  app.get(options.tvPath, (c) => {
    return c.html(csrShell({
      cssPath: options.tvCss,
      jsPath: options.tvJs,
      title: options.title,
      headContent: options.headContent,
    }))
  })
}
