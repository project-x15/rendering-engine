import type { SsrTemplateOpts, CsrShellOpts } from './types.js'

const DATA_WARN_THRESHOLD = 100_000 // 100KB — warn in dev

/**
 * SSR HTML — rendered content + __DATA__ for client hydration.
 * No hardcoded fonts or API keys. App provides headContent for fonts/meta.
 *
 * Warns in development when __DATA__ exceeds 100KB.
 * Throws in production when __DATA__ exceeds maxDataSize (if set).
 */
export function ssrTemplate(opts: SsrTemplateOpts): string {
  const dataJson = JSON.stringify(opts.data).replace(/<\/script>/g, '<\\/script>')
  const title = opts.title ?? ''
  const head = opts.headContent ?? ''

  // Dev warning: large __DATA__ bloat
  if (dataJson.length > DATA_WARN_THRESHOLD) {
    const route = opts.routePath ?? '?'
    const sizeKB = (dataJson.length / 1024).toFixed(0)
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[x15/engine] SSR __DATA__ is ${sizeKB}KB for route "${route}". ` +
        `Large __DATA__ bloats every SSR response. ` +
        `Ensure getData returns only page-specific data, not the full config.`
      )
    }
  }

  // Hard cap: throw in production if maxDataSize exceeded
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
    + '<div id="app">' + opts.html + '</div>'
    + '<script id="__DATA__" type="application/json">' + dataJson + '</script>'
    + '<script src="' + opts.jsPath + '"></script>'
    + '</body>'
    + '</html>'
}

/**
 * TV CSR shell — empty #app, loads app.js for client-side render.
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