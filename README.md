# @project-x15/rendering-engine

**Alpha.** The API will change. Don't build a product on this yet.

Dual-mode rendering engine for streaming apps. Serves server-rendered HTML to web browsers and a client-side shell to 2015-era smart TVs.

Runs as a Hono app. Uses Preact for components and `preact-render-to-string` for SSR. Works on Cloudflare Workers out of the box, and Node.js, Bun, and Deno with one extra line.

Not published to npm. Install from GitHub:

Pin to a tagged release (recommended for consumers):

```
pnpm add github:project-x15/rendering-engine#v0.1.0
```

Or float on the default branch (for co-development):

```
pnpm add github:project-x15/rendering-engine
```

> **Toolchain requirement:** the package ships raw TypeScript (`main: ./src/index.ts`).
> Your build tool must import `.ts` directly — Vite, esbuild, Bun, Deno, and tsx all do.
> Plain Node and plain `tsc` will **not** work without a transpile step.

For private repos, git auth (SSH key or HTTPS token) is required. For local development:

```
git clone https://github.com/project-x15/rendering-engine.git
cd rendering-engine
pnpm install
```

---

## How it works

The engine detects the client on every request. Web browsers get fully rendered HTML with serialized page data. TV browsers (Tizen, WebOS, Roku, Apple TV) get an empty shell that loads a client-side JavaScript app.

Detection checks four signals, in order: a query param, a cookie, a client hint, and the User-Agent string. You can swap in your own detection function.

Every route can define a `getData` function that fetches page-specific data. The engine calls it during SSR and serializes the result into the HTML. The same function powers the `/api/data/*` endpoint for TV clients that need to fetch data after the shell loads.

---

## Quick start

The engine doesn't pick a runtime for you. `createApp` returns a Hono app. You hand it to whichever server you're running.

### Cloudflare Workers (default)

No `serveStatic` needed. Wrangler serves static assets from the `[assets]` directory in your `wrangler.toml`.

```ts
import { h } from 'preact'
import { createApp } from '@project-x15/rendering-engine'

const Home = () => h('div', null, 'Hello')

export default createApp({
  routes: [
    {
      path: '/',
      component: Home,
      getData: (ctx) => ({ title: 'Home', theme: ctx.config.theme }),
    },
  ],
  title: 'My App',
  configLoader: async () => ({ theme: 'dark' }),
})
```

```toml
# wrangler.toml
name = "my-app"
compatibility_date = "2025-07-01"

[assets]
directory = "./dist"
binding = "ASSETS"
```

Workers also gets the L2 cache layer for free. The config loader stores fetched config in the Cache API, so it survives isolate restarts. Node.js, Bun, and Deno only get L1 (in-memory).

### Node.js

Pass `serveStatic` from `@hono/node-server`. The engine uses it to register the `/tv/assets/*` and `/web/assets/*` routes.

```ts
import { h } from 'preact'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from '@project-x15/rendering-engine'

const Home = () => h('div', null, 'Hello')

const app = createApp({
  routes: [
    {
      path: '/',
      component: Home,
      getData: (ctx) => ({ title: 'Home', theme: ctx.config.theme }),
    },
  ],
  title: 'My App',
  configLoader: async () => ({ theme: 'dark' }),
  serveStatic,
})

serve(app)
```

Install the peer dep: `npm install @hono/node-server` (or `bun add @hono/node-server`, `deno add npm:@hono/node-server`).

### Bun

Bun supports `@hono/node-server` out of the box, so the Node.js example works as-is. Swap `serve` for `Bun.serve`:

```ts
import { h } from 'preact'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from '@project-x15/rendering-engine'

const app = createApp({
  routes: [{ path: '/', component: () => h('div', null, 'Hello') }],
  title: 'My App',
  configLoader: async () => ({ theme: 'dark' }),
  serveStatic,
})

export default {
  port: 3000,
  fetch: app.fetch,
}
```

Run with `bun run server.ts`.

### Deno

Deno has its own file API. Write a small `serveStatic` wrapper:

```ts
import { h } from 'preact'
import { createApp } from '@project-x15/rendering-engine'
import type { MiddlewareHandler } from 'hono'

const serveStatic = (opts: { root: string }): MiddlewareHandler =>
  async (c) => {
    const path = new URL(c.req.url).pathname
    const file = await Deno.readFile(`${opts.root}${path}`)
    return new Response(file)
  }

const app = createApp({
  routes: [{ path: '/', component: () => h('div', null, 'Hello') }],
  title: 'My App',
  configLoader: async () => ({ theme: 'dark' }),
  serveStatic,
})

Deno.serve(app.fetch)
```

Run with `deno run --allow-net --allow-read server.ts`.

---

## API

### `createApp(options)`

Returns a Hono app. The app handles four kinds of requests.

**Page routes** render your Preact components. Web clients get SSR with `__DATA__` for hydration. TV clients get the CSR shell.

**`/api/data/*`** returns JSON from a route's `getData` function. TV clients use this after the shell loads.

**`/api/config`** returns the cached global config as JSON. Only registered when you provide a `configLoader`.

**Static assets** are served when you provide a `serveStatic` option. The engine registers `/tv/assets/*` and `/web/assets/*` using your handler. On Workers, skip this and let wrangler handle it.

### Options

| Option | Default | What it does |
|---|---|---|
| `routes` | required | Array of route objects |
| `title` | `''` | HTML `<title>` |
| `headContent` | `''` | Extra `<head>` content (fonts, meta, analytics) |
| `assetsRoot` | `'./dist'` | Root directory for static assets |
| `webCssPath` | `'/web/assets/style.css'` | Web CSS path |
| `webJsPath` | `'/web/assets/client.js'` | Web JS path |
| `tvCssPath` | `'/tv/assets/style.css'` | TV CSS path |
| `tvJsPath` | `'/tv/assets/app.js'` | TV JS path |
| `tvPath` | `'/tv'` | Direct TV shell URL |
| `detectMode` | built-in detector | Override mode detection |
| `getEnv` | `() => ({})` | Resolve per-request env |
| `configLoader` | none | Async config fetcher; receives an optional `AbortSignal` for timeout cancellation |
| `maxDataSize` | 524288 (512KB) | Hard cap on `__DATA__` in bytes. Set to `Infinity` to disable |
| `serveStatic` | none | Static asset middleware factory (Node, Bun, Deno) |

### Route object

```ts
{
  path: '/show/:id',
  component: ShowPage,
  getData: (ctx) => fetchShow(ctx.params.id),
  beforeRender: (data) => trackAnalytics(data),
  onError: (err) => ({ error: err.message }),
}
```

`getData` receives a `RequestContext` with `params`, `request`, `mode`, `env`, and `config`. Return only the data the page needs. Returning the full config object embeds megabytes into every HTML response.

`beforeRender` runs after data is fetched but before the component renders. Use it for side effects like analytics. If it throws, the error is logged and the render continues — a failing analytics call does not take down the page.

`onError` catches errors from `getData`. Return a fallback data object. Without it, the engine renders `{ error: message }`.

### `createConfigLoader(fetcher, cacheKey?, ttl?)`

Creates a config loader with two cache layers. L1 is an in-memory cache that deduplicates concurrent calls, and L2 is the Cache API, which survives isolate restarts on Cloudflare Workers. On Node.js, Bun, and Deno, only L1 is available.

```ts
const loader = createConfigLoader(async () => fetchConfig())
const config = await loader.load()  // cached after first call
loader.reset()                       // clear L1, force refetch
```

### `detectMode(req)`

Returns `'ssr'` or `'csr'`. Checks query params, cookies, client hints, and User-Agent in that order. Defaults to `'ssr'`.

### `matchRoute(routes, pathname)`

Matches a pathname against the route table. Supports exact paths, static paths, and `:param` segments, and returns `{ route, params }` or `null`. Trailing slashes are normalized, and malformed percent-encoding returns `null` instead of crashing.

### `ssrTemplate(opts)` / `csrShell(opts)`

Low-level HTML template functions. `ssrTemplate` wraps rendered HTML with `__DATA__` and asset links, and `csrShell` produces the empty TV shell. Both escape `</script>` in data to prevent XSS.

---

## Config caching

The config loader uses a two-layer cache. L1 is an in-memory reference that makes repeated reads instant. L2 is the Cache API, which persists across Worker restarts.

Concurrent calls to `load()` share a single pending promise. The first call fetches, the rest wait for the same result. If the fetch fails, the pending promise is cleared so the next call retries instead of returning a stale rejection.

The `reset()` method clears L1 only. L2 expires via its TTL or is overwritten on the next successful fetch.

---

## Testing

The test suite uses Node's built-in test runner. Run it with `npm test`.

The engine has a Deterministic Simulation Testing suite. It generates random sequences of page requests, API calls, config resets, and failure injections from a fixed seed. Every scenario runs twice, traces are deep-compared, and invariants are checked on every step against an independent reference model.

This catches bugs that unit tests miss: race conditions in the config dedup, state leaks across requests, and subtle interactions between mode detection and error handling.

---

## What the engine doesn't do

It doesn't build your client bundle, handle auth or sessions, or give you a CLI, dev server, or plugin system. It renders pages and serves data. That's it.

The engine is 530 lines across seven files. Every line earns its keep.