# Project

## What this is

A rendering engine for a streaming app that needs to serve both modern web browsers and 2015-era smart TVs. The same Preact components and the same route table power both modes. The engine decides per-request which mode to use, fetches page data, renders HTML, and serves JSON endpoints for the TV client.

## Why two modes

2015-era TVs (Tizen 2.4, WebOS 1.x, Roku) have weak JavaScript engines and limited DOM APIs. Server-side rendering with a hydration step doesn't work reliably on them. The engine sends these devices an empty HTML shell and a client-side JavaScript bundle. The TV client fetches page data from `/api/data/*` and renders entirely on the client.

Modern browsers get fully server-rendered HTML with serialized `__DATA__` for hydration. No client-side data fetching needed for the initial render.

## Runtime support

The engine targets Cloudflare Workers first. It also runs on Node.js, Bun, and Deno.

The only runtime-specific code is static asset serving. Workers handles this via wrangler's `[assets]` config. Node.js, Bun, and Deno pass a `serveStatic` middleware factory. The engine accepts it as an optional parameter and skips asset routes entirely when it's omitted.

The config loader uses the Cache API for its L2 cache layer on Workers. This survives isolate restarts. Node.js, Bun, and Deno don't have the Cache API, so they get L1 only (in-memory). This is fine because their processes persist across requests.

## File responsibilities

`app.ts` is the factory. It creates a Hono app, wires routes, configures the config loader, and handles mode detection per request. 134 lines.

`config.ts` manages the two-layer cache. L1 is an in-memory reference with concurrent request deduplication. L2 is the Cache API for Workers. 96 lines.

`mode.ts` detects whether a request is from a TV or a web browser. Four signals checked in priority order. 46 lines.

`router.ts` matches pathnames against the route table. Supports exact, static, and `:param` segments. No wildcards, no regex. 44 lines.

`html.ts` produces the two HTML shells. `ssrTemplate` wraps rendered content with `__DATA__` and asset links. `csrShell` produces the empty TV shell. Both escape `</script>` to prevent XSS. 79 lines.

`types.ts` defines all shared types. 117 lines.

`index.ts` re-exports everything. 14 lines.

## Data flow

```
Request arrives
  |
  v
detectMode(req) --> 'ssr' or 'csr'
  |
  +-- 'csr' --> csrShell() --> empty HTML + TV JS/CSS
  |
  +-- 'ssr' --> matchRoute(routes, path)
                  |
                  v
                route.getData(ctx) --> page data
                  |
                  v
                renderToString(component) --> HTML string
                  |
                  v
                ssrTemplate({ html, data }) --> full HTML with __DATA__
```

TV client flow:
```
TV loads CSR shell
  |
  v
fetch('/api/data/show/123') --> matchRoute --> getData(ctx) --> JSON
  |
  v
fetch('/api/config') --> config.load() --> cached config JSON
  |
  v
client renders Preact component with fetched data
```

## Config cache state machine

```
load() called
  |
  +-- L1 hit (cached !== null) --> return cached instantly
  |
  +-- L1 miss, pending exists --> return pending (dedup)
  |
  +-- L1 miss, no pending --> start fetch
        |
        +-- L2 hit (Cache API) --> populate L1, return
        |
        +-- L2 miss --> fetcher() --> store L2 (fire-and-forget) + store L1, return
        |
        +-- fetcher throws --> clear pending, throw (next call retries)
```

`reset()` clears L1 only. L2 expires via TTL or is overwritten on next fetch.

## Error handling

`getData` can throw. The engine catches it and checks for `route.onError`. If provided, `onError` returns fallback data. If not, the engine uses `{ error: err.message }`. In both cases, the component re-renders with the fallback data and the response includes `__DATA__` with the error payload.

The `/api/data/*` and `/api/config` endpoints return 500 with `{ error: message }` JSON on failure. Config fetch failures are never cached. The pending promise is cleared so the next request retries.

`maxDataSize` throws when `__DATA__` exceeds the limit. This throw is caught by the SSR error handler, which renders an error page. If the error data also exceeds the limit (e.g. `onError` returns large data), the throw escapes to Hono's default 500 handler.

## Testing strategy

Three layers.

Unit tests cover each module independently. `mode.test.ts` checks every detection signal. `router.test.ts` covers matching, params, trailing slashes, and malformed encoding. `html.test.ts` verifies template output and XSS escaping. `config.test.ts` tests cache hits, misses, dedup, reset, and L2 round-trips.

Integration tests in `app.test.ts` exercise the full `createApp` flow: SSR rendering, CSR shell serving, `/api/data` responses, config caching, and error fallbacks. `defaults.test.ts` covers every `??` fallback branch in both directions.

The DST suite in `dst.test.ts` is the strongest layer. It generates random operation sequences from a fixed seed: page requests with mixed mode signals, API calls, config resets, and failure injections. Each scenario runs twice and the traces are deep-compared for byte-identical reproducibility. An independent reference model predicts the expected response for every step. Invariants are checked per-step, not just at the end. This catches race conditions in config dedup, state leaks across requests, and subtle interactions between mode detection and error handling.

The large-config suite in `large-config.test.ts` stresses the engine with 3MB config payloads. It checks for OOM, timing regressions, content integrity after cache round-trips, and verifies that SSR `__DATA__` doesn't accidentally inline the full config.

## What changed for multi-runtime support

The engine originally hardcoded `import { serveStatic } from '@hono/node-server/serve-static'` at the top of `app.ts`. That import throws on Cloudflare Workers because `@hono/node-server` is Node-specific.

The fix: `serveStatic` is now an optional parameter on `createApp`. When provided, the engine registers `/tv/assets/*` and `/web/assets/*` routes using that handler. When omitted, no asset routes are registered. Workers users omit it (wrangler handles assets). Node, Bun, and Deno users pass their platform's static file handler.

`@hono/node-server` is now an optional peer dependency in `package.json`.