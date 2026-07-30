import type { SsrTemplateOpts, CsrShellOpts } from './types.js'

const DATA_WARN_THRESHOLD = 100_000 // 100KB — warn in dev

/**
 * SSR HTML — rendered content + __DATA__ for client hydration.
 * No hardcoded fonts or API keys. App provides headContent for fonts/meta.
 *
 * Warns when `dev` is true and __DATA__ exceeds 100KB.
 * Throws when __DATA__ exceeds maxDataSize (if set).
 */
export function ssrTemplate(opts: SsrTemplateOpts): string {
  const dataJson = JSON.stringify(opts.data).replace(/<\/script>/g, '<\\/script>')
  const title = opts.title ?? ''
  const head = opts.headContent ?? ''

  // Dev warning: large __DATA__ bloat. Gated on an explicit `dev` flag, not
  // on process.env.NODE_ENV, so the engine stays environment-agnostic.
  if (opts.dev && dataJson.length > DATA_WARN_THRESHOLD) {
    const route = opts.routePath ?? '?'
    const sizeKB = (dataJson.length / 1024).toFixed(0)
    console.warn(
      `[x15/engine] SSR __DATA__ is ${sizeKB}KB for route "${route}". ` +
      `Large __DATA__ bloats every SSR response. ` +
      `Ensure getData returns only page-specific data, not the full config.`
    )
  }

  if (opts.maxDataSize && dataJson.length > opts.maxDataSize) {
    const route = opts.routePath ?? '?'
    const sizeKB = (dataJson.length / 1024).toFixed(0)
    const limitKB = (opts.maxDataSize / 1024).toFixed(0)
    throw new Error(
      `[x15/engine] SSR __DATA__ for route "${route}" is ${sizeKB}KB, ` +
      `exceeds limit of ${limitKB}KB. ` +
      `Reduce getData return value or increase maxDataSize.`
    )
  }

  // Attribute-encode request-derived values to prevent XSS.
  // cssPath, jsPath, title, headContent are set by the app developer
  // at build time, not from user input — safe to interpolate directly.
  // ssrDataUrl is derived from c.req.path (user-controlled) — encode it.
  const ssrDataUrlSafe = opts.ssrDataUrl
    ? opts.ssrDataUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    : ''

  return '<!DOCTYPE html>'
    + '<html lang="en">'
    + '<head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + (title ? '<title>' + title + '</title>' : '')
    + head
    + '<link rel="stylesheet" href="' + opts.cssPath + '">'
    + '</head>'
    + '<body>'
    + '<div id="app" data-ssr="true"'
    + (ssrDataUrlSafe ? ' data-ssr-url="' + ssrDataUrlSafe + '"' : '')
    + '>' + opts.html + '</div>'
    + '<script id="__DATA__" type="application/json">' + dataJson + '</script>'
    + '<script src="' + opts.jsPath + '"></script>'
    + '</body>'
    + '</html>'
}

/**
 * TV CSR shell — empty #app, loads app.js for client-side render.
 *
 * Deliberately omits `data-ssr-url`: the SSR template adds it so client JS can
 * re-fetch page data if it discards the server HTML. The TV client never has
 * server HTML to discard — it always fetches from `/api/data` + its own path —
 * so the hint would be unused. Both clients share the same `/api/data/*`
 * protocol; only the bootstrap differs.
 */
export function csrShell(opts: CsrShellOpts): string {
  const title = opts.title ?? ''
  const head = opts.headContent ?? ''

  return '<!DOCTYPE html>'
    + '<html lang="en">'
    + '<head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + (title ? '<title>' + title + '</title>' : '')
    + head
    + '<link rel="stylesheet" href="' + opts.cssPath + '">'
    + '</head>'
    + '<body class="tv-mode">'
    + '<div id="app"></div>'
    + '<script src="' + opts.jsPath + '"></script>'
    + '</body>'
    + '</html>'
}