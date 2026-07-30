import { test } from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'preact'
import { createApp } from '../src/app.js'
import type { Route, AppOptions } from '../src/types.js'
import { captureWarn, captureLogger, type CapturedLog } from './helpers.js'

const TestPage = ({ data }: { data: Record<string, unknown> }) => h('div', null, String(data.title ?? 'empty'))

const routes: Route[] = [
  {
    path: '/',
    component: TestPage,
    getData: (ctx) => ({ title: 'Test Show', theme: ctx.config.theme ?? 'none' }),
    onError: (err) => ({ title: 'Error: ' + err.message }),
  },
  {
    path: '/show/:id',
    component: TestPage,
    getData: (ctx) => ({ title: 'Show ' + ctx.params.id }),
  },
]

function makeApp(overrides: Partial<AppOptions> = {}): ReturnType<typeof createApp> {
  return createApp({
    routes,
    title: 'TestApp',
    headContent: '<meta name="test" content="engine">',
    getEnv: () => ({ MOCK_MODE: 'test' }),
    configLoader: async () => ({ theme: 'dark' }),
    circuitBreakerCooldownMs: 0,
    ...overrides,
  })
}

async function fetchHtml(app: ReturnType<typeof createApp>, path: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await app.fetch(new Request('http://localhost' + path, { headers }))
  return res.text()
}

// ── SSR ──

test('SSR: web UA gets rendered HTML with data', async () => {
  const html = await fetchHtml(makeApp(), '/')
  assert.ok(html.includes('Test Show'))
  assert.ok(html.includes('__DATA__'))
})

test('SSR: headContent injected into HTML head', async () => {
  const html = await fetchHtml(makeApp(), '/')
  assert.ok(html.includes('<meta name="test" content="engine">'))
})

test('SSR: title appears in HTML', async () => {
  const html = await fetchHtml(makeApp(), '/')
  assert.ok(html.includes('<title>TestApp</title>'))
})

test('SSR: env passed to getData via ctx.env', async () => {
  const app = makeApp({
    routes: [{
      path: '/env',
      component: TestPage,
      getData: (ctx) => ({ title: ctx.env.MOCK_MODE === 'test' ? 'Env Works' : 'No Env' }),
    }],
  })
  const html = await fetchHtml(app, '/env')
  assert.ok(html.includes('Env Works'))
})

// ── CSR ──

test('CSR: TV UA gets empty shell', async () => {
  const html = await fetchHtml(makeApp(), '/', { 'user-agent': 'Mozilla/5.0 (Tizen 2.4)' })
  assert.ok(html.includes('<div id="app"></div>'))
  assert.ok(!html.includes('Test Show'))
})

test('CSR: ?tv=1 gets empty shell', async () => {
  const html = await fetchHtml(makeApp(), '/?tv=1')
  assert.ok(html.includes('<div id="app"></div>'))
})

test('/tv: direct TV access serves CSR shell', async () => {
  const html = await fetchHtml(makeApp(), '/tv')
  assert.ok(html.includes('<div id="app"></div>'))
  assert.ok(html.includes('tv-mode'))
})

// ── /api/data ──

test('/api/data/: returns JSON with page data', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/data/'))
  const json: any = await res.json()
  assert.equal(json.title, 'Test Show')
})

test('/api/data/show/123: extracts params', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/data/show/123'))
  const json: any = await res.json()
  assert.equal(json.title, 'Show 123')
})

test('/api/data/unknown: 404', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/data/unknown'))
  assert.equal(res.status, 404)
})

test('/api/data: root path resolves to / after prefix strip', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/data'))
  const json: any = await res.json()
  assert.equal(json.title, 'Test Show', 'stripping /api/data prefix should resolve to / route')
})

test('/api/data: prefix strip is anchored — does not strip substring later in path', async () => {
  // Route whose path contains a segment that could be confused with the prefix.
  // The strip must remove only the leading /api/data, not a later occurrence.
  const app = makeApp({
    routes: [
      { path: '/data-check/:id', component: TestPage, getData: (ctx) => ({ title: 'Check ' + ctx.params.id }) },
    ],
    configLoader: async () => ({ theme: 'dark' }),
  })
  const res = await app.fetch(new Request('http://localhost/api/data/data-check/42'))
  const json: any = await res.json()
  assert.equal(json.title, 'Check 42', 'must resolve to /data-check/42, not /data/42 or similar')
})

test('/api/data/unknown/deep/path: catch-all returns JSON 404 (not Hono default text)', async () => {
  // After migrating from matchRoute to Hono's router, unknown /api/data paths
  // fall through to the catch-all handler. It must return JSON, not Hono's
  // default text 404, so TV clients can parse the error.
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/data/unknown/deep/path'))
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json')
  const json: any = await res.json()
  assert.equal(json.error, 'Not found')
})

test('/api/data uses Hono router — validateParams rejection returns 404', async () => {
  const app = makeApp({
    routes: [{
      path: '/guarded/:id',
      component: TestPage,
      getData: (ctx) => ({ title: 'Guarded ' + ctx.params.id }),
      validateParams: (p) => /^\d+$/.test(p.id),
    }],
    configLoader: async () => ({}),
  })
  // Valid params — serves data
  const ok = await app.fetch(new Request('http://localhost/api/data/guarded/42'))
  assert.equal(ok.status, 200)
  // Invalid params — 404 (validateParams returns false)
  const bad = await app.fetch(new Request('http://localhost/api/data/guarded/abc'))
  assert.equal(bad.status, 404)
})

// ── Config ──

test('config: passed to getData via ctx.config', async () => {
  const html = await fetchHtml(makeApp(), '/')
  assert.ok(html.includes('dark'), 'config.theme should reach rendered HTML')
})

test('config: cached — configLoader called once across requests', async () => {
  let calls = 0
  const app = makeApp({
    configLoader: async () => { calls++; return { theme: 'dark' } },
  })
  await fetchHtml(app, '/')
  await fetchHtml(app, '/')
  await fetchHtml(app, '/')
  assert.equal(calls, 1, 'configLoader should only be called once')
})

test('/api/config: returns cached config JSON', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/config'))
  const json: any = await res.json()
  assert.equal(json.theme, 'dark')
})

test('/api/config: cached across requests', async () => {
  let calls = 0
  const app = makeApp({
    configLoader: async () => { calls++; return { theme: 'dark' } },
  })
  await app.fetch(new Request('http://localhost/api/config'))
  await app.fetch(new Request('http://localhost/api/config'))
  assert.equal(calls, 1)
})

// ── Error handling ──

test('SSR: getData error triggers onError fallback', async () => {
  const app = makeApp({
    routes: [{
      path: '/fail',
      component: TestPage,
      getData: () => { throw new Error('fetch failed') },
      onError: (err) => ({ title: 'Error: ' + err.message }),
    }],
  })
  const html = await fetchHtml(app, '/fail')
  assert.ok(html.includes('Error: fetch failed'))
  assert.ok(html.includes('__DATA__'))
})

// ── Config load failure: graceful degradation, not silent swallow ──
//
// Reproduces the cold-start "first request fails" symptom: config.load() rejects
// (e.g. IPv6 DNS race against the config server). The SSR/data chain must keep
// rendering with an empty config instead of hitting onError — but the failure
// must be observable (logged with context), never silently swallowed.

// A configLoader that always rejects, simulating the cold-start fetch failure.
function failingConfigLoader(): () => Promise<Record<string, unknown>> {
  return async () => { throw new Error('fetch failed') }
}

test('SSR: config load failure degrades gracefully (renders, no error state)', async () => {
  const app = makeApp({ configLoader: failingConfigLoader() })
  const html = await fetchHtml(app, '/')
  // Page still renders with real data — config is optional.
  assert.ok(html.includes('Test Show'), 'page renders without config')
  assert.ok(!html.includes('Error: fetch failed'), 'config failure must not trigger onError')
  // getData saw an empty config (theme ?? 'none' -> 'none').
  assert.ok(html.includes('none'), 'ctx.config degraded to {}')
})

test('SSR: config load failure is logged (not silently swallowed)', async () => {
  const cap = captureWarn()
  try {
    const app = makeApp({ configLoader: failingConfigLoader() })
    await fetchHtml(app, '/')
    const warned = cap.messages.some((args) =>
      typeof args[0] === 'string' && /config: load failed/.test(args[0])
    )
    assert.ok(warned, 'config load failure must be logged with context')
  } finally {
    cap.restore()
  }
})

test('/api/data: config load failure degrades gracefully', async () => {
  const app = makeApp({ configLoader: failingConfigLoader() })
  const res = await app.fetch(new Request('http://localhost/api/data/'))
  assert.equal(res.status, 200)
  const json: any = await res.json()
  assert.equal(json.title, 'Test Show', 'data endpoint still serves page data')
  assert.equal(json.theme, 'none', 'ctx.config degraded to {}')
})

test('/api/config: config load failure still surfaces 500 to TV clients', async () => {
  // The degradation is SSR/data-only; /api/config must keep surfacing errors
  // so TV clients know config is unavailable (no silent swallowing here).
  const app = makeApp({ configLoader: failingConfigLoader() })
  const res = await app.fetch(new Request('http://localhost/api/config'))
  assert.equal(res.status, 500)
  const json: any = await res.json()
  assert.equal(json.error, 'fetch failed')
})

test('SSR: config failure retries on next request (failure not cached)', async () => {
  // Mirrors config.ts: a rejected load clears `pending` so the next request
  // retries. Once the config server recovers, SSR picks up real config.
  let calls = 0
  let broken = true
  const app = makeApp({
    configLoader: async () => {
      calls++
      if (broken) throw new Error('fetch failed')
      return { theme: 'dark' }
    },
  })
  const first = await fetchHtml(app, '/')
  assert.ok(first.includes('none'), 'first request degrades')
  broken = false
  const second = await fetchHtml(app, '/')
  assert.ok(second.includes('dark'), 'second request uses recovered config')
  assert.equal(calls, 2, 'config loader retried after failure')
})

// ── beforeRender: async-safe fire-and-forget ────────────────────────────
//
// beforeRender is a side-effect hook (analytics, tracking). It may be sync
// or async. The engine must never let a failing hook break the render, and
// an async rejection must never become an unhandled rejection. The hook is
// fire-and-forget: its result is not awaited on the SSR response path.

test('SSR: sync-throwing beforeRender is caught (render continues)', async () => {
  const app = makeApp({
    routes: [{
      path: '/sync-hook',
      component: TestPage,
      getData: () => ({ title: 'Sync Hook' }),
      beforeRender: () => { throw new Error('sync hook boom') },
    }],
  })
  const html = await fetchHtml(app, '/sync-hook')
  assert.ok(html.includes('Sync Hook'), 'render succeeds despite sync beforeRender throw')
  assert.ok(html.includes('__DATA__'))
})

test('SSR: async beforeRender rejection is caught (no unhandled rejection)', async () => {
  let unhandled = false
  const handler = () => { unhandled = true }
  process.on('unhandledRejection', handler)
  try {
    const app = makeApp({
      routes: [{
        path: '/async-hook',
 component: TestPage,
        getData: () => ({ title: 'Async Hook' }),
        beforeRender: async () => { throw new Error('async hook boom') },
      }],
    })
    const html = await fetchHtml(app, '/async-hook')
    // Let the rejected promise settle so an unhandled rejection would surface.
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(html.includes('Async Hook'), 'render succeeds despite async beforeRender rejection')
    assert.equal(unhandled, false, 'async beforeRender rejection must not become an unhandled rejection')
  } finally {
    process.off('unhandledRejection', handler)
  }
})

test('SSR: async beforeRender does not block the response', async () => {
  // A slow async beforeRender must not delay the SSR response — the hook is
  // fire-and-forget. We assert the response resolves well before the hook's
  // deferred work completes.
  let hookFinished = false
  const app = makeApp({
    routes: [{
      path: '/slow-hook',
      component: TestPage,
      getData: () => ({ title: 'Slow Hook' }),
      beforeRender: async () => {
        await new Promise((r) => setTimeout(r, 100))
        hookFinished = true
      },
    }],
  })
  const start = performance.now()
  const html = await fetchHtml(app, '/slow-hook')
  const elapsed = performance.now() - start
  assert.ok(html.includes('Slow Hook'))
  assert.ok(elapsed < 80, `SSR response must not wait for async beforeRender (took ${elapsed.toFixed(0)}ms)`)
  assert.equal(hookFinished, false, 'response returned before the slow hook completed')
})

// ── dev option: large __DATA__ warning wired through the app ────────────

test('SSR: dev option surfaces large __DATA__ warning through the app', async () => {
  const cap = captureWarn()
  try {
    const app = makeApp({
      dev: true,
      routes: [{
        path: '/big',
        component: TestPage,
        getData: () => ({ title: 'x'.repeat(150_000) }),
      }],
    })
    await fetchHtml(app, '/big')
    const warned = cap.messages.some((args) => typeof args[0] === 'string' && /SSR __DATA__ is/.test(args[0]))
    assert.ok(warned, 'dev:true app should warn on large __DATA__')
  } finally {
    cap.restore()
  }
})

test('SSR: dev unset (default) does not warn on large __DATA__', async () => {
  const cap = captureWarn()
  try {
    const app = makeApp({
      routes: [{
        path: '/big',
      component: TestPage,
        getData: () => ({ title: 'x'.repeat(150_000) }),
      }],
    })
    await fetchHtml(app, '/big')
    const warned = cap.messages.some((args) => typeof args[0] === 'string' && /SSR __DATA__ is/.test(args[0]))
    assert.ok(!warned, 'default (dev off) must not warn on large __DATA__')
  } finally {
    cap.restore()
  }
})

// ── Concurrent SSR: data via props, not shared state (race condition fix) ──
//
// Before the fix, components received null props and data was passed via
// beforeRender setting module-level mutable state. Under concurrent SSR
// requests on the same isolate, requests would clobber each other's data.
// Now data is passed as props — each request has its own props closure.

test('SSR: concurrent requests do not clobber each other data (props, not shared state)', async () => {
  // Component renders its data title from props — no shared state.
  const ConcurrentPage = ({ data }: { data: Record<string, unknown> }) =>
    h('div', { 'data-testid': 'content' }, String(data.title ?? 'empty'))

  const app = createApp({
    routes: [
      { path: '/page-a', component: ConcurrentPage, getData: () => ({ title: 'AAA' }) },
      { path: '/page-b', component: ConcurrentPage, getData: () => ({ title: 'BBB' }) },
    ],
    configLoader: async () => ({}),
  })

  // Fire both requests concurrently — if data were shared mutable state,
  // one would clobber the other.
  const [resA, resB] = await Promise.all([
    app.fetch(new Request('http://localhost/page-a', { headers: { 'user-agent': 'Mozilla/5.0' } })),
    app.fetch(new Request('http://localhost/page-b', { headers: { 'user-agent': 'Mozilla/5.0' } })),
  ])

  const htmlA = await resA.text()
  const htmlB = await resB.text()

  assert.ok(htmlA.includes('AAA'), 'page A must render its own data')
  assert.ok(htmlB.includes('BBB'), 'page B must render its own data')
  assert.ok(!htmlA.includes('BBB'), 'page A must not have page B data')
  assert.ok(!htmlB.includes('AAA'), 'page B must not have page A data')
})

// ── Structured logging ──────────────────────────────────────────────────
//
// The engine must pass structured fields to the logger (requestId, route,
// durationMs, error) instead of interpolating them into free-text strings.
// This makes logs parseable by log pipelines (Logpush, Datadog, etc.).

test('logging: SSR completion passes structured fields', async () => {
  const { logger, logs } = captureLogger()
  const app = createApp({
    routes: [{ path: '/', component: TestPage, getData: () => ({ title: 'Test' }) }],
    configLoader: async () => ({}),
    logger,
  })
  await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const entry = logs.find((l) => l.level === 'info' && /SSR.*completed/.test(l.message))
  assert.ok(entry, 'SSR completion must be logged')
  assert.ok(entry.fields, 'must have structured fields')
  assert.equal(typeof entry.fields!.requestId, 'string', 'requestId must be a string')
  assert.equal(typeof entry.fields!.durationMs, 'number', 'durationMs must be a number')
})

test('logging: /api/config passes structured fields with durationMs', async () => {
  const { logger, logs } = captureLogger()
  const app = createApp({
    routes: [{ path: '/', component: TestPage }],
    configLoader: async () => ({ theme: 'dark' }),
    logger,
  })
  await app.fetch(new Request('http://localhost/api/config'))
  const entry = logs.find((l) => l.level === 'info' && /api\/config.*served/.test(l.message))
  assert.ok(entry, '/api/config served must be logged')
  assert.ok(entry.fields, 'must have structured fields')
  assert.equal(typeof entry.fields!.requestId, 'string', 'requestId must be present')
  assert.equal(typeof entry.fields!.durationMs, 'number', 'durationMs must be present')
})

test('logging: /api/data passes structured fields with path and durationMs', async () => {
  const { logger, logs } = captureLogger()
  const app = createApp({
    routes: [{ path: '/show/:id', component: TestPage, getData: (ctx) => ({ title: ctx.params.id }) }],
    configLoader: async () => ({}),
    logger,
  })
  await app.fetch(new Request('http://localhost/api/data/show/42'))
  const entry = logs.find((l) => l.level === 'info' && /api\/data.*served/.test(l.message))
  assert.ok(entry, '/api/data served must be logged')
  assert.ok(entry.fields, 'must have structured fields')
  assert.equal(entry.fields!.path, '/show/42', 'path field must be the resolved route path')
  assert.equal(typeof entry.fields!.durationMs, 'number', 'durationMs must be present')
})

test('logging: config load failure passes error as structured field', async () => {
  const { logger, logs } = captureLogger()
  const app = createApp({
    routes: [{ path: '/', component: TestPage }],
    configLoader: async () => { throw new Error('config down') },
    circuitBreakerCooldownMs: 0,
    logger,
  })
  await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const entry = logs.find((l) => l.level === 'warn' && /config.*load failed/.test(l.message))
  assert.ok(entry, 'config load failure must be logged as warn')
  assert.ok(entry.fields, 'must have structured fields')
  assert.ok(entry.fields!.error instanceof Error, 'error must be an Error object in fields')
  assert.equal(typeof entry.fields!.requestId, 'string', 'requestId must be present')
})

test('logging: /api/config error passes error as structured field', async () => {
  const { logger, logs } = captureLogger()
  const app = createApp({
    routes: [{ path: '/', component: TestPage }],
    configLoader: async () => { throw new Error('config down') },
    circuitBreakerCooldownMs: 0,
    logger,
  })
  await app.fetch(new Request('http://localhost/api/config'))
  const entry = logs.find((l) => l.level === 'error' && /api\/config.*failed/.test(l.message))
  assert.ok(entry, '/api/config failure must be logged as error')
  assert.ok(entry.fields, 'must have structured fields')
  assert.ok(entry.fields!.error instanceof Error, 'error must be an Error object in fields')
})

test('logging: beforeRender failure passes error as structured field', async () => {
  const { logger, logs } = captureLogger()
  const app = createApp({
    routes: [{
      path: '/hook',
      component: TestPage,
      getData: () => ({ title: 'Hook' }),
      beforeRender: () => { throw new Error('hook boom') },
    }],
    configLoader: async () => ({}),
    logger,
  })
  await app.fetch(new Request('http://localhost/hook', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const entry = logs.find((l) => l.level === 'warn' && /beforeRender.*failed/.test(l.message))
  assert.ok(entry, 'beforeRender failure must be logged as warn')
  assert.ok(entry.fields, 'must have structured fields')
  assert.ok(entry.fields!.error instanceof Error, 'error must be an Error object in fields')
})

// ── Security headers ───────────────────────────────────────────────────
//
// The engine sets X-Content-Type-Options: nosniff on all responses by default.
// The securityHeaders option allows customizing or disabling them.

test('security: SSR HTML response has X-Content-Type-Options: nosniff', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
})

test('security: /api/data response has X-Content-Type-Options: nosniff', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/data/'))
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
})

test('security: /api/config response has X-Content-Type-Options: nosniff', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/config'))
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
})

test('security: CSR shell response has X-Content-Type-Options: nosniff', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/tv'))
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
})

test('security: securityHeaders false disables all headers', async () => {
  const app = makeApp({ securityHeaders: false })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  assert.equal(res.headers.get('x-content-type-options'), null)
})

test('security: custom securityHeaders merge with defaults', async () => {
  const app = makeApp({
    securityHeaders: { 'X-Frame-Options': 'DENY' },
  })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'default header must persist')
  assert.equal(res.headers.get('x-frame-options'), 'DENY', 'custom header must be added')
})

test('security: custom securityHeaders can override default', async () => {
  const app = makeApp({
    securityHeaders: { 'X-Content-Type-Options': '' },
  })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  assert.equal(res.headers.get('x-content-type-options'), null, 'empty string removes the default')
})