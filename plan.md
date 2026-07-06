# Plan: throwback-engine

> Dual-mode rendering engine: SSR for web browsers, CSR shell for 2015-era TVs (Tizen 2.4, WebOS 1.x).
> Runs as a Hono app on Node.js (via `@hono/node-server`).

---

## What shipped

```
packages/throwback-engine/
  package.json          ← peerDeps: preact, @preact/signals, hono, @hono/node-server
                        ← deps: preact-render-to-string
                        ← sideEffects: false
                        ← exports: "." (server only)
  tsconfig.json
  src/
    index.ts            ← server barrel: createApp, createConfigLoader, detectMode, matchRoute, ssrTemplate, csrShell
    app.ts              ← createApp (Hono app: mode → SSR/CSR/API)
    config.ts           ← createConfigLoader (L1 in-memory + L2 Cache API, dedup)
    mode.ts             ← detectMode (4-signal detection)
    router.ts           ← matchRoute (path matching with params, URIError-safe)
    html.ts             ← ssrTemplate, csrShell (HTML shells)
    types.ts            ← Mode, Route, RequestContext, AppOptions, SsrTemplateOpts, CsrShellOpts, MatchedRoute
  test/
    app.test.ts         ← SSR, CSR shell, /api/data, config caching, error handling
    config.test.ts      ← config loader cache + dedup
    html.test.ts        ← template output
    mode.test.ts        ← UA/cookie/query detection
    router.test.ts      ← path matching, params, edge cases
```

### Single export path

```
throwback-engine → src/index.ts → server code (Hono app, modern JS)
```

No client export. The app builds its own client bundle (Preact + components) and serves it as a static asset.

---

## Public API

### `createApp`

```ts
import { createApp } from 'throwback-engine'
import { routes } from './routes'

const app = createApp({ routes })
export default app
```

Returns a Hono instance. The app can add custom routes before the engine's catch-all:

```ts
app.post('/api/watchlist', myHandler)
```

**Options:**

```ts
interface AppOptions {
  routes: Route[]
  assetsRoot?: string           // default: './dist' (static file root for serveStatic)
  webCssPath?: string            // default: '/web/assets/style.css'
  webJsPath?: string             // default: '/web/assets/client.js'
  tvCssPath?: string             // default: '/tv/assets/style.css'
  tvJsPath?: string              // default: '/tv/assets/app.js'
  title?: string                 // default: '' (HTML <title>)
  headContent?: string           // default: '' (extra <head> content: fonts, meta, analytics)
  tvPath?: string                // default: '/tv' (direct TV access route)
  detectMode?: (req: Request) => Mode   // default: built-in 4-signal detection
  getEnv?: (c: Context) => Record<string, unknown>  // resolve app env from Hono context
  configLoader?: () => Promise<Record<string, unknown>>  // global config fetcher (cached)
}
```

### Route definition

```ts
interface Route<TState = Record<string, unknown>> {
  path: string
  component: ComponentType<Record<string, unknown>>
  getData?: (ctx: RequestContext) => Promise<Partial<TState>> | Partial<TState>
  beforeRender?: (data: Partial<TState>) => void
  onError?: (err: Error) => Partial<TState>
}
```

### Request context

```ts
interface RequestContext {
  params: Record<string, string>
  request: Request
  mode: Mode            // 'ssr' | 'csr'
  env: Record<string, unknown>    // app-specific env from getEnv
  config: Record<string, unknown>  // cached global config from configLoader
}
```

### Low-level exports

```ts
import { detectMode, matchRoute, createConfigLoader, ssrTemplate, csrShell } from 'throwback-engine'
```

Each is a pure function, available for testing or custom integrations.

---

## Internal Architecture

### app.ts — `createApp`

Hono app builder. Handles five request paths:

```
1. /tv/assets/* and /web/assets/*  → serveStatic (static files)
2. /tv                              → CSR shell HTML (direct TV access)
3. /api/config                      → cached global config JSON
4. /api/data/*                      → page data JSON for TV CSR
5. /{route}                         → mode detect → SSR (web) or CSR shell (TV)
```

**SSR flow:**

```
request → detectMode(request)
  if 'csr' → return CSR shell HTML (TV)

  if 'ssr' →
    resolveEnv(c)
    config.load() → ctx.config
    route.getData(ctx) → data
    route.beforeRender(data)
    renderToString(h(route.component)) → html
    ssrTemplate({ html, data, cssPath, jsPath, title, headContent })

    on getData error:
      route.onError(err) → errorData
      route.beforeRender(errorData)
      renderToString(h(route.component)) → html
      ssrTemplate({ html, data: errorData, ... })
```

**`/api/data/*` flow:**

```
pathname = path.replace('/api/data', '') || '/'
matchRoute(routes, pathname) → matched
  if null → 404 JSON

resolveEnv(c) → ctx.env
config.load() → ctx.config
matched.route.getData(ctx) → data
return JSON(data)

on error → 500 JSON with error message
```

**`/api/config` flow:**

```
config.load() → cached config JSON
return JSON(config)
```

### config.ts — `createConfigLoader`

Two-layer cache for global config (theme, features, etc.):

```
L1: in-memory (instant, dedup concurrent requests, lost on isolate restart)
L2: Cache API (caches.default, persists across isolate restarts on Workers)
    — not available on Node.js (L1 only, process persists)

load():
  L1 hit → return cached (instant)
  L1 pending → return shared promise (dedup)
  L1 miss → check L2 → fetch origin → store L1 + L2 → return

reset():
  clears L1 only (L2 expires via TTL or overwrites on next fetch)
```

### mode.ts — `detectMode`

Four-signal detection, checked in priority order:

```
1. Query param   ?tv=1 → csr    ?web=1 → ssr
2. Cookie        tv-mode=1 → csr  tv-mode=0 → ssr
3. Client hint   Sec-CH-UA-Platform contains "tv" → csr
4. User-Agent    keyword match (tizen, webos, roku, appletv, hbbtv, ...) → csr
   fallback → ssr
```

Keyword list: `tv`, `smarttv`, `smart-tv`, `smart_tv`, `webos`, `netcast`, `tizen`, `roku`, `aftt`, `aftb`, `aftm`, `appletv`, `apple tv`, `applecoremedia`, `hbbtv`, `viera`, `bravia`, `googletv`, `espial`, `nettv`, `opera tv`.

### router.ts — `matchRoute`

Simple path matcher. No wildcards, no regex.

```
matchRoute(routes, pathname) → { route, params } | null

Patterns:
  "/"           → exact match
  "/browse"     → static segment
  "/watch/:id"  → param (params.id = decodeURIComponent(value))

Normalization: trailing slash stripped (except root)
Matching: first match wins
URIError safety: malformed percent-encoding → returns null (no-match)
```

### html.ts — `ssrTemplate` / `csrShell`

**ssrTemplate** — SSR HTML with rendered content + `__DATA__` for client hydration:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  {title ? <title>{title}</title> : ''}
  {headContent}
  <link rel="stylesheet" href="{cssPath}">
</head>
<body>
  <div id="app">{renderedHtml}</div>
  <script id="__DATA__" type="application/json">{JSON.stringify(data) — </script> escaped}</script>
  <script src="{jsPath}"></script>
</body>
</html>
```

**csrShell** — empty `#app` div, loads app.js for client-side render:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  {title ? <title>{title}</title> : ''}
  {headContent}
  <link rel="stylesheet" href="{cssPath}">
</head>
<body class="tv-mode">
  <div id="app"></div>
  <script src="{jsPath}"></script>
</body>
</html>
```

---

## Error handling

**getData fails (SSR):**

```
route.onError(err) → errorData
  if onError exists → render error page with errorData
  if no onError    → errorData = { error: err.message }, render with that
```

**getData fails (/api/data):**

```
.catch → 500 JSON { error: err.message }
```

**Route not found (/api/data):**

```
matchRoute returns null → 404 JSON { error: 'Not found' }
```

---

## Divergence from original design

The original plan (dated 2026-07-05) described a more ambitious engine. Here's what changed and why:

| Feature | Original plan | What shipped | Why |
|---------|--------------|--------------|-----|
| Entry point | `createWorker` (Cloudflare Worker handler) | `createApp` (Hono app on `@hono/node-server`) | Node.js target is more immediately deployable. App can add custom Hono routes directly. |
| Store | `createStore`, `hydrate`, `StoreProvider`, `useStore` (signal bag) | Not implemented | App manages its own state. The signal-based store added complexity without a clear consumer in the first deployment. |
| Client entry | `mountWeb` (hydration from `__DATA__`), `mountTV` (cold-start CSR) | Not implemented | App builds its own client bundle. The engine's value is server-side mode detection + SSR + data API, not client-side rendering. |
| `renderSSR` | Standalone pure function | Inlined into `createApp` route handler | One less indirection. The render pipeline is simple enough to inline. |
| `createHonoApp` escape hatch | Separate function for custom routes | Not needed — `createApp` already returns a Hono instance | The app can add routes directly on the returned app. |
| Spatial navigation | `@throwback/engine/spatial` (D-pad focus engine, ~200 lines) | Not implemented | Deferred. Not needed for first deployment. |
| KV caching | SWR via `env[cacheBinding]` | Not implemented | Config caching (L1+L2 in `config.ts`) covers the main need. Per-route HTML caching deferred. |
| Error handling | App-level `errorComponent` / `notFoundComponent` | Per-route `onError` + `beforeRender` hooks | More granular — different routes can fail differently. |
| Config loading | Not in plan | `configLoader` with L1 (in-memory) + L2 (Cache API) + dedup | Added to solve the global config problem (theme, features) that the plan didn't address. |
| `getEnv` | Not in plan | `getEnv?: (c: Context) => Record<string, unknown>` | Added to pass app-specific env (API keys, headers) to `getData`. |
| Package name | `@throwback/engine` (scoped) | `throwback-engine` (unscoped) | Simpler npm publishing. |
| Exports | `.`, `./client`, `./store`, `./spatial` | `.` only | Only the server path exists. |

---

## Testing

| Layer | What | Tool |
|-------|------|------|
| Unit | `matchRoute` — path matching, params, URIError edge cases | node:test |
| Unit | `detectMode` — UA strings, cookies, query params | node:test |
| Unit | `createConfigLoader` — cache hit/miss, dedup, reset | node:test |
| Unit | `ssrTemplate` / `csrShell` — HTML output | node:test |
| Integration | `createApp` — SSR HTML, CSR shell, /api/data, config, errors | node:test + Hono.fetch |

```
test/
  app.test.ts       ← SSR, CSR shell, /api/data, config caching, error handling
  config.test.ts    ← config loader L1 cache, dedup, reset, /api/config
  html.test.ts      ← ssrTemplate, csrShell output
  mode.test.ts      ← detectMode 4-signal detection
  router.test.ts    ← matchRoute exact/static/param/trailing-slash/unknown
```

Run: `npm test` (54 tests, all passing).

---

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-05 | Extract engine into separate package | Team parallelization |
| 2026-07-05 | Name: throwback-engine | Communicates the constraint (2015-era platforms) |
| 2026-07-05 | Dual-mode (SSR + CSR) via mode detection | Same routes serve both targets |
| 2026-07-05 | `/api/data/*` endpoint for TV CSR | Same `getData` serves SSR and TV. No duplicate data layer |
| 2026-07-06 | Target Node.js (`@hono/node-server`) instead of Cloudflare Workers only | More deployable. `createApp` returns Hono instance directly. |
| 2026-07-06 | Drop store/signal system for first release | Added complexity without a consumer. App manages its own state. |
| 2026-07-06 | Drop client-side `mountWeb`/`mountTV` | App builds its own client bundle. Engine's value is server-side. |
| 2026-07-06 | Add `configLoader` with L1+L2 cache | Global config (theme, features) needed caching + dedup. Not in original plan. |
| 2026-07-06 | Per-route `onError` + `beforeRender` instead of app-level error component | More granular error handling per route. |
| 2026-07-06 | Add `getEnv` to AppOptions | Pass app-specific env (API keys, headers) to `getData`. |