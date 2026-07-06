import { test } from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'preact'
import { createApp } from '../src/app.js'
import type { Route, AppOptions } from '../src/types.js'

let renderedData: Record<string, unknown> = {}
const TestPage = () => h('div', null, String(renderedData.title ?? 'empty'))

const routes: Route[] = [
  {
    path: '/',
    component: TestPage,
    getData: (ctx) => ({ title: 'Test Show', theme: ctx.config.theme ?? 'none' }),
    beforeRender: (d: any) => { renderedData = d },
    onError: (err) => ({ title: 'Error: ' + err.message }),
  },
  {
    path: '/show/:id',
    component: TestPage,
    getData: (ctx) => ({ title: 'Show ' + ctx.params.id }),
    beforeRender: (d: any) => { renderedData = d },
  },
]

function makeApp(overrides: Partial<AppOptions> = {}): ReturnType<typeof createApp> {
  renderedData = {}
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
      beforeRender: (d: any) => { renderedData = d },
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
      beforeRender: (d: any) => { renderedData = d },
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

// Capture console.warn so tests can assert the failure is surfaced to logs.
function captureWarn(): { messages: any[]; restore: () => void } {
  const messages: any[] = []
  const original = console.warn
  console.warn = (...args: any[]) => { messages.push(args) }
  return { messages, restore: () => { console.warn = original } }
}

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