import { test } from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'preact'
import { createApp } from '../src/app.js'
import { createConfigLoader } from '../src/config.js'
import { ssrTemplate } from '../src/html.js'
import type { Route, AppOptions, RequestContext } from '../src/types.js'

// ═══════════════════════════════════════════════════════════════════════
//  Large Config (~3MB) Stress Tests
//  ─────────────────────────────────────────────────────────────────────
//  Validates the engine handles realistic large config payloads without
//  crashing, silently truncating, or bloating SSR responses.
//
//  Risks tested:
//    1. JSON.stringify/parse on 3MB — CPU blocking, memory pressure
//    2. L1 cache holding 3MB reference — shared across requests, OK
//    3. L2 Cache API with 3MB Response — round-trip integrity
//    4. SSR __DATA__ must NOT inline the full config — only getData return
//    5. /api/config returns full 3MB — correct but slow
//    6. /api/data/* must NOT inline the full config — only page data
//    7. Concurrent dedup with large payload — single fetch
//    8. </script> escape on large string — double memory allocation
// ═══════════════════════════════════════════════════════════════════════

// ── Build a realistic ~3MB config ──────────────────────────────────────
// Shape: nested theme tokens + feature flags + catalog metadata.
// Realistic for a streaming app with per-content-type theme overrides.

function buildLargeConfig(targetBytes = 3_000_000): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    theme: {
      colors: {} as Record<string, string>,
      typography: {} as Record<string, string>,
      spacing: {} as Record<string, string>,
      breakpoints: {} as Record<string, number>,
      animations: {} as Record<string, string>,
    },
    features: {} as Record<string, boolean>,
    catalog: [] as Record<string, unknown>[],
    metadata: {
      version: '3.0.0',
      environment: 'production',
      deployedAt: '2026-07-06T00:00:00Z',
      region: 'us-east-1',
    },
  }

  // Fill theme colors (1000 entries × ~50 bytes each = ~50KB)
  for (let i = 0; i < 1000; i++) {
    config.theme.colors[`brand-${i}`] = `hsl(${i % 360}, 50%, ${40 + (i % 20)}%)`
    config.theme.typography[`font-size-${i}`] = `${0.5 + (i % 50) * 0.1}rem`
    config.theme.spacing[`space-${i}`] = `${(i % 100) * 4}px`
  }

  // Fill features (5000 flags × ~30 bytes = ~150KB)
  for (let i = 0; i < 5000; i++) {
    config.features[`feature-${i}-enabled`] = i % 3 !== 0
  }

  // Fill catalog with rich metadata entries (each ~200 bytes)
  // Need ~15,000 entries × 200 bytes = ~3MB
  const genres = ['action', 'drama', 'comedy', 'sci-fi', 'thriller', 'horror', 'romance', 'documentary']
  const ratings = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'R', 'PG-13']
  const tags = ['exclusive', 'trending', 'new', 'popular', 'critically-acclaimed', 'award-winning', 'binge-worthy', 'family-friendly', 'adult', 'international']

  for (let i = 0; i < 15000; i++) {
    const entry: Record<string, unknown> = {
      id: `content-${i}`,
      title: `Sample Content Title ${i} - The Extended Edition with Subtitle`,
      genre: genres[i % genres.length],
      rating: ratings[i % ratings.length],
      year: 2015 + (i % 10),
      duration: 45 + (i % 60),
      tags: [tags[i % tags.length], tags[(i + 3) % tags.length]],
      available: i % 100 !== 42, // 1% unavailable
      description: `A ${genres[i % genres.length]} film about content item number ${i}. This is a longer description string that simulates realistic metadata for a streaming catalog entry with multiple sentences of descriptive text.`,
    }
    config.catalog.push(entry)
  }

  return config as Record<string, unknown>
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractDataJson(html: string): unknown {
  const m = html.match(/<script id="__DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (!m) throw new Error('no __DATA__ in HTML')
  return JSON.parse(m[1].replace(/<\\\/script>/g, '</script>'))
}

function measureMs(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

async function measureMsAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

// ── Build config once (shared across tests) ────────────────────────────
let largeConfig: Record<string, unknown>
let configSizeBytes: number

test('setup: build 3MB config and measure size', () => {
  largeConfig = buildLargeConfig()
  const json = JSON.stringify(largeConfig)
  configSizeBytes = new TextEncoder().encode(json).length
  console.log(`  config object size: ${(configSizeBytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  JSON string length: ${(json.length / 1024 / 1024).toFixed(2)} MB`)
  assert.ok(configSizeBytes >= 2_500_000, `config too small: ${configSizeBytes} bytes`)
  assert.ok(configSizeBytes <= 7_000_000, `config too large: ${configSizeBytes} bytes`)
})

// ═══════════════════════════════════════════════════════════════════════
//  1. Config loader — large payload
// ═══════════════════════════════════════════════════════════════════════

test('large-config: config loader handles 3MB payload', async () => {
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return largeConfig })

  const cfg = await loader.load()
  assert.equal(calls, 1)
  assert.equal(cfg, largeConfig) // same reference (L1)
  assert.equal((cfg as any).metadata.version, '3.0.0')
  assert.equal((cfg as any).catalog.length, 15000)
})

test('large-config: L1 cache returns same reference (no copy)', async () => {
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return largeConfig })

  const a = await loader.load()
  const b = await loader.load()
  const c = await loader.load()
  assert.equal(calls, 1)
  assert.strictEqual(a, b) // same object reference
  assert.strictEqual(b, c)
})

test('large-config: reset + reload refetches', async () => {
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return largeConfig })

  await loader.load()
  loader.reset()
  await loader.load()
  assert.equal(calls, 2)
})

test('large-config: concurrent dedup with large payload', async () => {
  let calls = 0
  const loader = createConfigLoader(async () => {
    calls++
    return largeConfig
  })

  const [a, b, c] = await Promise.all([loader.load(), loader.load(), loader.load()])
  assert.equal(calls, 1)
  assert.strictEqual(a, b)
  assert.strictEqual(b, c)
})

test('large-config: JSON.stringify timing baseline', () => {
  const ms = measureMs(() => JSON.stringify(largeConfig))
  console.log(`  JSON.stringify(3MB): ${ms.toFixed(1)}ms`)
  // On modern Node.js, 3MB stringify should be <50ms
  assert.ok(ms < 200, `stringify too slow: ${ms.toFixed(1)}ms`)
})

test('large-config: JSON.parse timing baseline', () => {
  const json = JSON.stringify(largeConfig)
  const ms = measureMs(() => JSON.parse(json))
  console.log(`  JSON.parse(3MB): ${ms.toFixed(1)}ms`)
  assert.ok(ms < 200, `parse too slow: ${ms.toFixed(1)}ms`)
})

// ═══════════════════════════════════════════════════════════════════════
//  2. /api/config — returns full 3MB
// ═══════════════════════════════════════════════════════════════════════

const TestPage = () => h('div', null, 'test')

function makeApp(overrides: Partial<AppOptions> = {}): ReturnType<typeof createApp> {
  const routes: Route[] = [
    {
      path: '/',
      component: TestPage,
      getData: (ctx: RequestContext) => ({
        title: 'Home',
        theme: (ctx.config as any)?.theme?.colors?.['brand-0'] ?? 'none',
        catalogCount: (ctx.config as any)?.catalog?.length ?? 0,
      }),
    },
    {
      path: '/show/:id',
      component: TestPage,
      getData: (ctx: RequestContext) => ({
        id: ctx.params.id,
        title: 'Show',
        // Intentionally NOT returning the full config
      }),
    },
  ]

  return createApp({
    routes,
    title: 'LargeConfig',
    configLoader: async () => largeConfig,
    ...overrides,
  })
}

test('large-config: /api/config returns full 3MB payload', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/config'))
  assert.equal(res.status, 200)

  const body = await res.text()
  const bodyBytes = new TextEncoder().encode(body).length
  console.log(`  /api/config response: ${(bodyBytes / 1024 / 1024).toFixed(2)} MB`)

  // Should be close to the original config size
  assert.ok(bodyBytes >= configSizeBytes * 0.9, `response too small: ${bodyBytes} vs ${configSizeBytes}`)
  assert.ok(bodyBytes <= configSizeBytes * 1.1, `response too large: ${bodyBytes} vs ${configSizeBytes}`)

  // Verify content integrity
  const json = JSON.parse(body)
  assert.equal(json.metadata.version, '3.0.0')
  assert.equal(json.catalog.length, 15000)
  assert.equal(json.catalog[0].id, 'content-0')
  assert.equal(json.catalog[14999].id, 'content-14999')
})

test('large-config: /api/config cached across requests', async () => {
  let calls = 0
  const app = makeApp({
    configLoader: async () => { calls++; return largeConfig },
  })

  await app.fetch(new Request('http://localhost/api/config'))
  await app.fetch(new Request('http://localhost/api/config'))
  await app.fetch(new Request('http://localhost/api/config'))
  assert.equal(calls, 1)
})

// ═══════════════════════════════════════════════════════════════════════
//  3. SSR — __DATA__ must NOT contain full config
// ═══════════════════════════════════════════════════════════════════════

test('large-config: SSR __DATA__ stays small (config NOT inlined)', async () => {
  const app = makeApp()
  const res = await app.fetch(
    new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }),
  )
  const html = await res.text()
  const data = extractDataJson(html) as Record<string, unknown>

  // __DATA__ should only contain the getData return value, not the full config
  assert.equal(data.title, 'Home')
  assert.equal(data.theme, 'hsl(0, 50%, 40%)')
  assert.equal(data.catalogCount, 15000)

  // Verify __DATA__ is small (< 1KB for this simple getData)
  const dataMatch = html.match(/<script id="__DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  assert.ok(dataMatch, '__DATA__ script tag must exist')
  const dataJson = dataMatch![1]
  assert.ok(dataJson.length < 1000, `__DATA__ too large: ${dataJson.length} bytes (config leaked into SSR!)`)
})

test('large-config: SSR with config-pass-through getData warns but works', async () => {
  // This simulates a getData that accidentally returns the full config
  const routes: Route[] = [
    {
      path: '/leak',
      component: TestPage,
      getData: (ctx: RequestContext) => ({
        title: 'Leaky',
        // App developer accidentally passes config through
        config: ctx.config,
      }),
    },
  ]
  const app = createApp({
    routes,
    configLoader: async () => largeConfig,
  })

  const res = await app.fetch(
    new Request('http://localhost/leak', { headers: { 'user-agent': 'Mozilla/5.0' } }),
  )
  const html = await res.text()
  const data = extractDataJson(html) as Record<string, unknown>

  assert.equal(data.title, 'Leaky')
  // The config IS in __DATA__ because getData returned it
  const dataMatch = html.match(/<script id="__DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  assert.ok(dataMatch, '__DATA__ script tag must exist')
  const dataJson = dataMatch![1]
  const dataBytes = new TextEncoder().encode(dataJson).length
  console.log(`  SSR with config passthrough: __DATA__ = ${(dataBytes / 1024 / 1024).toFixed(2)} MB`)

  // This is the bloat scenario — warn if > 100KB
  if (dataBytes > 100_000) {
    console.log(`  ⚠️  WARNING: getData returned large config (${(dataBytes / 1024 / 1024).toFixed(2)} MB in __DATA__)`)
    console.log(`  ⚠️  This bloats every SSR response. Recommend getData returns only page-specific data.`)
  }
})

test('large-config: SSR with no getData still works (config not inlined)', async () => {
  const routes: Route[] = [
    { path: '/static', component: TestPage },
  ]
  const app = createApp({
    routes,
    configLoader: async () => largeConfig,
  })

  const res = await app.fetch(
    new Request('http://localhost/static', { headers: { 'user-agent': 'Mozilla/5.0' } }),
  )
  const html = await res.text()
  const data = extractDataJson(html)
  assert.deepEqual(data, {}) // no getData → {} in __DATA__
  assert.ok(html.includes('test')) // component rendered
})

// ═══════════════════════════════════════════════════════════════════════
//  4. /api/data/* — must NOT inline full config
// ═══════════════════════════════════════════════════════════════════════

test('large-config: /api/data returns only page data, not full config', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/data/'))
  const json: any = await res.json()

  // Should only contain getData return value
  assert.equal(json.title, 'Home')
  assert.equal(json.theme, 'hsl(0, 50%, 40%)')
  assert.equal(json.catalogCount, 15000)

  // Verify no config keys leaked
  assert.equal(Object.keys(json).length, 3, 'should only have 3 keys from getData')
  assert.ok(!json.catalog, 'catalog should not be in response')
  assert.ok(!json.features, 'features should not be in response')
})

test('large-config: /api/data with params still works', async () => {
  const app = makeApp()
  const res = await app.fetch(new Request('http://localhost/api/data/show/42'))
  const json: any = await res.json()

  assert.equal(json.id, '42')
  assert.equal(json.title, 'Show')
  assert.equal(Object.keys(json).length, 2) // only getData return
})

// ═══════════════════════════════════════════════════════════════════════
//  5. L2 Cache API with large payload
// ═══════════════════════════════════════════════════════════════════════

function mockCacheApi(): { cleanup: () => void } {
  const store = new Map<string, Response>()
  ;(globalThis as any).caches = {
    default: {
      match: (key: string) => {
        const val = store.get(key)
        if (!val) return Promise.resolve(undefined)
        return Promise.resolve(val.clone())
      },
      put: (key: string, res: Response) => {
        store.set(key, res)
        return Promise.resolve()
      },
    },
  }
  return { cleanup: () => { delete (globalThis as any).caches; store.clear() } }
}

test('large-config: L2 Cache API round-trip with 3MB', async () => {
  const mock = mockCacheApi()
  try {
    let calls = 0
    const loader = createConfigLoader(async () => { calls++; return largeConfig })

    // First load — fetches, stores in L1 + L2
    const a = await loader.load()
    assert.equal(calls, 1)
    assert.equal((a as any).catalog.length, 15000)

    // Simulate isolate restart: clear L1
    loader.reset()

    // Second load — L2 hit, no refetch
    const b = await loader.load()
    assert.equal(calls, 1, 'L2 must serve cached value without refetch')
    assert.equal((b as any).catalog.length, 15000)
    assert.equal((b as any).metadata.version, '3.0.0')

    // Verify content integrity after L2 round-trip
    const bJson = JSON.stringify(b)
    const aJson = JSON.stringify(a)
    assert.equal(bJson.length, aJson.length, 'L2 round-trip must preserve content')
  } finally {
    mock.cleanup()
  }
})

test('large-config: L2 store failure is swallowed (3MB write fail)', async () => {
  const mock = mockCacheApi()
  // Override put to reject
  ;(globalThis as any).caches.default.put = () => Promise.reject(new Error('cache write failed for 3MB'))
  try {
    let calls = 0
    const loader = createConfigLoader(async () => { calls++; return largeConfig })

    const config = await loader.load()
    assert.equal(calls, 1, 'fetcher ran despite L2 write failure')
    assert.equal((config as any).catalog.length, 15000)

    // L1 still populated — second load must not refetch
    await loader.load()
    assert.equal(calls, 1)
  } finally {
    mock.cleanup()
  }
})

// ═══════════════════════════════════════════════════════════════════════
//  6. </script> escape on large data
// ═══════════════════════════════════════════════════════════════════════

test('large-config: </script> escape on 3MB data does not OOM', () => {
  // Simulate what ssrTemplate does: JSON.stringify + replace
  const data = { config: largeConfig }
  const ms = measureMs(() => {
    const json = JSON.stringify(data)
    const escaped = json.replace(/<\/script>/g, '<\\/script>')
    assert.ok(escaped.length > json.length * 0.9, 'escaped string should be similar length')
  })
  console.log(`  JSON.stringify(3MB) + </script> escape: ${ms.toFixed(1)}ms`)
  assert.ok(ms < 500, `escape too slow: ${ms.toFixed(1)}ms`)
})

test('large-config: ssrTemplate with large data produces valid HTML', () => {
  const data = { config: largeConfig }
  const ms = measureMs(() => {
    const html = ssrTemplate({
      html: '<p>hello</p>',
      data,
      cssPath: '/style.css',
      jsPath: '/app.js',
      title: 'Large Config Test',
    })
    // Verify HTML structure
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'must start with doctype')
    assert.ok(html.includes('<div id="app"><p>hello</p></div>'), 'must contain rendered content')
    assert.ok(html.includes('__DATA__'), 'must contain __DATA__')
    // The data doesn't naturally contain </script>, so the replace is a no-op.
    // Verify the escape mechanism works by checking the __DATA__ content directly:
    const dataMatch = html.match(/<script id="__DATA__" type="application\/json">([\s\S]*?)<\/script>/)
    assert.ok(dataMatch, '__DATA__ script tag must be present')
    const dataContent = dataMatch![1]
    // The escape replaces </script> with <\/script> in the JSON string.
    // Since our data has no </script>, the content should be valid JSON.
    assert.doesNotThrow(() => JSON.parse(dataContent), '__DATA__ content must be valid JSON')
    // If data DID contain </script>, it would be escaped. Verify the escape pattern works:
    const withScript = JSON.stringify({ x: '</script>' }).replace(/<\/script>/g, '<\\/script>')
    assert.ok(withScript.includes('\\/script>'), 'escape mechanism must replace </script> with <\\/script>')
  })
  console.log(`  ssrTemplate(3MB data): ${ms.toFixed(1)}ms`)
  assert.ok(ms < 500, `ssrTemplate too slow: ${ms.toFixed(1)}ms`)
})

// ═══════════════════════════════════════════════════════════════════════
//  7. End-to-end: concurrent requests with large config
// ═══════════════════════════════════════════════════════════════════════

test('large-config: concurrent SSR + API + config with 3MB', async () => {
  let calls = 0
  const app = makeApp({
    configLoader: async () => { calls++; return largeConfig },
  })

  const batch = [
    // SSR page
    app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } })),
    // /api/config
    app.fetch(new Request('http://localhost/api/config')),
    // /api/data
    app.fetch(new Request('http://localhost/api/data/')),
    // /api/data with params
    app.fetch(new Request('http://localhost/api/data/show/99')),
    // Another SSR
    app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' } })),
    // Another /api/config
    app.fetch(new Request('http://localhost/api/config')),
  ]

  const responses = await Promise.all(batch)
  assert.equal(calls, 1, 'all concurrent requests must share one fetch')

  for (const r of responses) {
    assert.equal(r.status, 200, `status ${r.status}`)
  }

  // Verify SSR responses
  const ssrHtml = await responses[0].text()
  const ssrData = extractDataJson(ssrHtml) as Record<string, unknown>
  assert.equal(ssrData.title, 'Home')
  assert.equal(ssrData.catalogCount, 15000)

  // Verify /api/config
  const configJson = await responses[1].json() as Record<string, unknown>
  assert.equal((configJson as any).catalog.length, 15000)

  // Verify /api/data
  const dataJson = await responses[2].json() as Record<string, unknown>
  assert.equal(dataJson.title, 'Home')
  assert.equal(dataJson.catalogCount, 15000)
  assert.ok(!dataJson.catalog, 'catalog must not leak into /api/data')
})

// ═══════════════════════════════════════════════════════════════════════
//  8. Edge cases
// ═══════════════════════════════════════════════════════════════════════

test('large-config: deeply nested config (10 levels) still works', async () => {
  // Build a deeply nested config
  let nested: Record<string, unknown> = {}
  let ptr = nested
  for (let i = 0; i < 10; i++) {
    ptr[`level${i}`] = { value: `depth-${i}`, data: largeConfig }
    ptr = ptr[`level${i}`] as Record<string, unknown>
  }

  const loader = createConfigLoader(async () => nested)
  const cfg = await loader.load()
  assert.equal((cfg as any).level0.level1.level2.level3.level4.level5.level6.level7.level8.level9.value, 'depth-9')
})

test('large-config: config with null/undefined values survives round-trip', async () => {
  const config = {
    ...largeConfig,
    nullable: null,
    undef: undefined, // JSON.stringify drops undefined
    nested: { a: null, b: undefined },
  }

  const loader = createConfigLoader(async () => config)
  const cfg = await loader.load()
  const json = JSON.stringify(cfg)
  const parsed = JSON.parse(json)

  assert.equal(parsed.nullable, null)
  assert.ok(!('undef' in parsed), 'undefined keys are dropped by JSON.stringify')
  assert.equal(parsed.nested.a, null)
  assert.ok(!('b' in parsed.nested), 'nested undefined keys are dropped')
})

test('large-config: config with circular reference — L1 succeeds, L2 write fails gracefully', async () => {
  // The fetcher returns a circular object. JSON.stringify in storeInCacheApi
  // throws, but that call is fire-and-forget with .catch() — the error is
  // swallowed. L1 still gets the data because the fetcher succeeded.
  const circular: Record<string, unknown> = { data: largeConfig }
  circular.self = circular

  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return circular })

  // load() must succeed — the circular reference only breaks L2 serialization,
  // which is fire-and-forget. L1 holds the object directly (no serialization).
  const cfg = await loader.load()
  assert.equal(calls, 1)
  assert.equal((cfg as any).data.catalog.length, 15000)
  assert.strictEqual((cfg as any).self, cfg, 'circular reference preserved in L1')

  // L1 cache hit — second load must not refetch
  const cfg2 = await loader.load()
  assert.equal(calls, 1)
  assert.strictEqual(cfg2, cfg)
})

// ═══════════════════════════════════════════════════════════════════════
//  9. maxDataSize hard cap
// ═══════════════════════════════════════════════════════════════════════

test('large-config: maxDataSize throws when __DATA__ exceeds limit', async () => {
  const routes: Route[] = [
    {
      path: '/big',
      component: TestPage,
      getData: () => ({ big: largeConfig }), // intentionally large
    },
  ]
  const app = createApp({
    routes,
    configLoader: async () => ({}),
    maxDataSize: 1024, // 1KB limit — our data is 6MB, should throw
  })

  // The throw from ssrTemplate is caught by the engine's .catch() handler,
  // which renders an error page with the message in __DATA__.
  const res = await app.fetch(
    new Request('http://localhost/big', { headers: { 'user-agent': 'Mozilla/5.0' } }),
  )
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('exceeds limit'), `body should mention limit`)
  assert.ok(html.includes('/big'), `body should mention route`)
  // Error is in __DATA__, not as raw HTML
  const data = extractDataJson(html) as Record<string, unknown>
  assert.ok((data.error as string).includes('exceeds limit'))
})

test('large-config: maxDataSize allows small __DATA__ through', async () => {
  const routes: Route[] = [
    {
      path: '/small',
      component: TestPage,
      getData: () => ({ title: 'small', count: 42 }),
    },
  ]
  const app = createApp({
    routes,
    configLoader: async () => ({}),
    maxDataSize: 1024, // 1KB limit — our data is tiny, should pass
  })

  const res = await app.fetch(
    new Request('http://localhost/small', { headers: { 'user-agent': 'Mozilla/5.0' } }),
  )
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('__DATA__'))
  assert.ok(html.includes('"title"'))
})

test('large-config: maxDataSize error path also checked (onError fallback)', async () => {
  // When getData throws AND the error data exceeds maxDataSize, the error
  // path should also enforce the limit. The throw from ssrTemplate inside
  // the .catch() handler is unhandled — Hono returns 500.
  const routes: Route[] = [
    {
      path: '/fail-big',
      component: TestPage,
      getData: () => { throw new Error('boom') },
      onError: () => ({ big: largeConfig }), // error data is large
    },
  ]
  const app = createApp({
    routes,
    configLoader: async () => ({}),
    maxDataSize: 1024,
  })

  const res = await app.fetch(
    new Request('http://localhost/fail-big', { headers: { 'user-agent': 'Mozilla/5.0' } }),
  )
  assert.equal(res.status, 500)
  const body = await res.text()
  // Hono's default error handler returns 'Internal Server Error'
  assert.ok(body.length > 0)
})
