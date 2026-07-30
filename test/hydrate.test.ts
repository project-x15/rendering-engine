import { test } from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'preact'
import { createApp } from '../src/app.js'
import { ssrTemplate } from '../src/html.js'
import { extractData } from './helpers.js'
import type { Route, RequestContext } from '../src/types.js'

// ═════════════════════════════════════════════════════════════════════════
//  Hydration Error Tests
//  ───────────────────────────────────────────────────────────────────────
//  Hydration = client-side JS takes over server-rendered HTML.
//  A hydration error happens when the client expects different state than
//  what SSR produced. The engine's job: produce a deterministic, parseable,
//  correct __DATA__ payload every time, and never leak server state.
//
//  This file enumerates every known hydration error class and verifies the
//  engine handles it safely — either by producing correct output, rejecting
//  detectably, or degrading gracefully with a logged error.
// ═════════════════════════════════════════════════════════════════════════

const Cmp = () => h('div', { 'data-testid': 'root' }, 'R')

// ── 1. __DATA__ JSON validity ──────────────────────────────────────────

test('hydrate: __DATA__ must be valid JSON', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ str: 'hello', num: 42, bool: true, arr: [1, 2, 3], nested: { a: 1 } }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.deepEqual(data, { str: 'hello', num: 42, bool: true, arr: [1, 2, 3], nested: { a: 1 } })
})

test('hydrate: empty __DATA__ is valid JSON', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp }] // no getData
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.deepEqual(data, {}, 'no getData → {}')
})

// ── 2. Non-serializable values ─────────────────────────────────────────

test('hydrate: undefined in getData is dropped by JSON.stringify', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ a: undefined, b: 1 }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.ok(!('a' in data), 'undefined keys must be dropped by JSON.stringify')
  assert.equal(data.b, 1)
})

test('hydrate: Date in getData serializes to string', async () => {
  const d = new Date('2026-07-06T00:00:00Z')
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ date: d }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(typeof data.date, 'string', 'Date must serialize to string via JSON.stringify')
  assert.equal(data.date, d.toISOString())
})

test('hydrate: NaN in getData serializes to null', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ val: NaN }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.val, null, 'NaN must serialize to null')
})

test('hydrate: Infinity in getData serializes to null', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ val: Infinity }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.val, null, 'Infinity must serialize to null')
})

test('hydrate: BigInt in getData throws (not serializable)', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ val: BigInt(42) }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  assert.equal(res.status, 200, 'error fallback returns 200')
  const data = extractData(html)
  assert.ok(data.error, 'BigInt serialization fail must produce error in __DATA__')
})

// ── 3. config reference leak ───────────────────────────────────────────

test('hydrate: getData returning full config object is detected and thrown', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: (ctx: RequestContext) => ctx.config, // ← BUG: returns full config
  }]
  const app = createApp({
    routes,
    configLoader: async () => ({ theme: 'dark', features: { a: true, b: false } }),
  })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.ok(typeof data.error === 'string' && data.error.includes('config'), `error must mention config: ${data.error}`)
})

test('hydrate: config spread does not trigger reference guard but maxDataSize catches it', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: (ctx: RequestContext) => ({ ...ctx.config, extra: 'stuff' }),
  }]
  const app = createApp({
    routes,
    configLoader: async () => {
      const big: Record<string, unknown> = { theme: 'dark' }
      for (let i = 0; i < 1000; i++) big[`k${i}`] = 'v'.repeat(100)
      return big
    },
    maxDataSize: 1024,
  })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  assert.equal(res.status, 200, 'maxDataSize exceeded degrades to error fallback')
  const html = await res.text()
  const data = extractData(html)
  assert.ok(data.error as string, 'error must be present in __DATA__')
})

// ── 4. </script> escape integrity ──────────────────────────────────────

test('hydrate: </script> in getData is escaped in __DATA__', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ html: '</script><script>alert("xss")' }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const m = html.match(/<script id="__DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  assert.ok(m, '__DATA__ script tag must exist')
  assert.ok(!m[1].includes('</script>'), 'raw </script> must not appear in __DATA__ content')
  const data = JSON.parse(m[1].replace(/<\\\/script>/g, '</script>'))
  assert.equal(data.html, '</script><script>alert("xss")')
})

test('hydrate: __DATA__ with multiple </script> occurrences', async () => {
  const payload = 'a</script>b</script>c'
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ x: payload }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const m = html.match(/<script id="__DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  assert.ok(m, '__DATA__ must exist')
  assert.equal(m[1].split('<\\/script>').length - 1, 2, 'both </script> occurrences must be escaped')
  const data = JSON.parse(m[1].replace(/<\\\/script>/g, '</script>'))
  assert.equal(data.x, payload, 'round-trip must preserve payload')
})

// ── 5. beforeRender mutation ───────────────────────────────────────────

test('hydrate: beforeRender cannot mutate the data object (frozen)', async () => {
  const original = { title: 'safe', count: 1 }
  let captured: any
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: () => original,
    beforeRender: (d) => { captured = d; d.title = 'mutated' }, // ← would-be BUG: freeze prevents it
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  // Object.freeze in fireAndForgetBeforeRender prevents mutation.
  // The assignment throws in strict mode (ESM default), caught by the
  // fire-and-forget handler and logged. __DATA__ keeps the original value.
  assert.equal(data.title, 'safe', 'beforeRender mutation must not affect __DATA__ (frozen)')
})

test('hydrate: beforeRender throwing must not break SSR', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: () => ({ ok: true }),
    beforeRender: () => { throw new Error('beforeRender failed') },
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  assert.equal(res.status, 200, 'beforeRender throw must still return 200')
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.ok, true, 'data must survive beforeRender throw')
})

// ── 6. Mode consistency ────────────────────────────────────────────────

test('hydrate: SSR page must have __DATA__ (CSR must not)', async () => {
  const app = createApp({ routes: [{ path: '/', component: Cmp, getData: () => ({ mode: 'check' }) }] })
  const ssr = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const ssrHtml = await ssr.text()
  assert.ok(ssrHtml.includes('__DATA__'), 'SSR must have __DATA__')
  assert.ok(ssrHtml.includes('<div id="app"'), 'SSR must have rendered content in #app')
  const csr = await app.fetch(new Request('http://localhost/?tv=1'))
  const csrHtml = await csr.text()
  assert.ok(!csrHtml.includes('__DATA__'), 'CSR must not have __DATA__')
  assert.ok(csrHtml.includes('<div id="app"></div>'), 'CSR must have empty #app')
})

test('hydrate: /api/data returns JSON, not HTML', async () => {
  const app = createApp({ routes: [{ path: '/', component: Cmp, getData: () => ({ data: 'json' }) }] })
  const res = await app.fetch(new Request('http://localhost/api/data/'))
  const ct = res.headers.get('content-type') ?? ''
  assert.ok(ct.includes('json') || ct.includes('application/json'), `/api/data must return JSON, got ${ct}`)
  const json = await res.json()
  assert.equal(json.data, 'json')
})

// ── 7. Error path DATA shape ───────────────────────────────────────────

test('hydrate: onError data replaces normal getData in __DATA__', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: () => { throw new Error('db down') },
    onError: (err) => ({ error: err.message, fallback: true }),
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.error, 'db down', 'onError data must be in __DATA__')
  assert.equal(data.fallback, true, 'onError fallback flag must be in __DATA__')
})

test('hydrate: error with no onError produces {error} in __DATA__', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: () => { throw new Error('unhandled') },
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.error, 'unhandled', 'default error fallback must be in __DATA__')
})

// ── 8. Data consistency: same route, same result ───────────────────────

test('hydrate: same route produces deterministic __DATA__', async () => {
  const routes: Route[] = [{
    path: '/show/:id',
    component: Cmp,
    getData: (ctx) => ({ id: ctx.params.id, ts: 'constant' }),
  }]
  const app = createApp({ routes })
  const r1 = await app.fetch(new Request('http://localhost/show/42', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const r2 = await app.fetch(new Request('http://localhost/show/42', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const h1 = await r1.text()
  const h2 = await r2.text()
  const d1 = extractData(h1)
  const d2 = extractData(h2)
  assert.deepEqual(d1, d2, 'same route must produce same __DATA__')
})

// ── 9. No secrets in __DATA__ ──────────────────────────────────────────

test('hydrate: secrets in getData end up in __DATA__ (app responsibility)', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: (ctx: RequestContext) => ({
      title: 'Safe',
      apiKey: ctx.env.API_KEY,
    }),
  }]
  const app = createApp({
    routes,
    getEnv: () => ({ API_KEY: 'sk-abc123def456', DB_PASSWORD: 'supersecret' }),
  })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  assert.ok(html.includes('sk-abc'), 'secrets in getData end up in __DATA__ (app responsibility)')
})

// ── 10. Data size warnings ─────────────────────────────────────────────

test('hydrate: ssrTemplate warns when __DATA__ exceeds 100KB threshold', () => {
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
  try {
    const bigData = { items: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: 'x'.repeat(50) })) }
    ssrTemplate({ html: '<p>big</p>', data: bigData, cssPath: '/c.css', jsPath: '/j.js', routePath: '/big', dev: true })
    const hasWarning = warnings.some((w) => w.includes('__DATA__') && w.includes('KB'))
    assert.ok(hasWarning, 'ssrTemplate must warn when __DATA__ > 100KB')
  } finally {
    console.warn = origWarn
  }
})

test('hydrate: ssrTemplate does not warn for small data', () => {
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
  try {
    ssrTemplate({ html: '<p>small</p>', data: { ok: true }, cssPath: '/c.css', jsPath: '/j.js' })
    const hasWarning = warnings.some((w) => w.includes('__DATA__'))
    assert.ok(!hasWarning, 'small __DATA__ must not trigger warning')
  } finally {
    console.warn = origWarn
  }
})

// ── 11. SSR HTML structure consistency ─────────────────────────────────

test('hydrate: SSR HTML has required structure for client hydration', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ ok: true }) }]
  const app = createApp({ routes, title: 'HydrateTest', headContent: '<meta name="test" content="1">' })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'must start with doctype')
  assert.ok(html.includes('<html lang="en">'), 'must have html lang')
  assert.ok(html.includes('<head>'), 'must have head')
  assert.ok(html.includes('</head>'), 'must close head')
  assert.ok(html.includes('<body>'), 'must have body')
  assert.ok(html.includes('</body>'), 'must close body')
  assert.ok(html.includes('</html>'), 'must close html')
  const bodyContent = html.split('<body>')[1]?.split('</body>')[0] ?? ''
  assert.ok(bodyContent.includes('<div id="app"'), '#app must be inside body')
  assert.ok(bodyContent.includes('data-ssr="true"'), '#app must have data-ssr="true"')
  assert.ok(bodyContent.includes('__DATA__'), '__DATA__ must be inside body after #app')
  assert.ok(bodyContent.includes('src="/web/assets/client.js"'), 'client JS must be in body')
})

// ── 12. Multiple data keys ─────────────────────────────────────────────

test('hydrate: getData returns multiple keys, all present in __DATA__', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: () => ({ a: 1, b: 'two', c: true, d: null, e: [1, 2, 3], f: { g: 'h' } }),
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.a, 1)
  assert.equal(data.b, 'two')
  assert.equal(data.c, true)
  assert.equal(data.d, null)
  assert.deepEqual(data.e, [1, 2, 3])
  assert.deepEqual(data.f, { g: 'h' })
})

// ── 13. Config absence ─────────────────────────────────────────────────

test('hydrate: no configLoader → ctx.config is {}', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: (ctx: RequestContext) => ({ hasConfig: Object.keys(ctx.config).length > 0 }),
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.hasConfig, false, 'no configLoader → config is {}')
})

// ── 14. Error in error path (double fault) ─────────────────────────────

test('hydrate: onError throws — final fallback produces minimal page', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: () => { throw new Error('first') },
    onError: () => { throw new Error('second') },
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  assert.ok(html.includes('__DATA__'), 'double fault must still produce __DATA__')
  assert.ok(html.includes('Render error'), 'double fault must produce minimal fallback')
})

// ── 15. Param extraction consistency ───────────────────────────────────

test('hydrate: route params are correctly extracted and available in getData', async () => {
  const routes: Route[] = [{
    path: '/watch/:id/season/:s',
    component: Cmp,
    getData: (ctx: RequestContext) => ({ id: ctx.params.id, season: ctx.params.s }),
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/watch/abc123/season/3', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.id, 'abc123', 'param id must be extracted')
  assert.equal(data.season, '3', 'param s must be extracted')
})

// ── 16. Leading/trailing whitespace in data ────────────────────────────

test('hydrate: whitespace in getData values is preserved', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: () => ({ title: '  Hello World  ', description: 'Line1\nLine2' }),
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.title, '  Hello World  ', 'whitespace must be preserved')
  assert.equal(data.description, 'Line1\nLine2', 'newlines must be preserved')
})

// ── 17. Circular reference in getData ──────────────────────────────────

test('hydrate: circular reference in getData produces error fallback', async () => {
  const circular: Record<string, unknown> = { ok: true }
  circular.self = circular
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => circular }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  assert.equal(res.status, 200, 'circular ref should still return 200')
  const html = await res.text()
  const data = extractData(html)
  assert.ok(data.error, 'circular ref must produce error in __DATA__')
})

// ── 18. getData returning null ─────────────────────────────────────────

test('hydrate: getData returning null serializes to null in __DATA__', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => null as any }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  // getData returns null → Promise.resolve(null) → data is null → JSON.stringify(null) = 'null'
  assert.equal(data, null as any, 'null getData must produce null in __DATA__')
})

// ── 19. Symbol in getData ──────────────────────────────────────────────

test('hydrate: Symbol in getData is dropped by JSON.stringify', async () => {
  const sym = Symbol('secret')
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ a: 1, [sym]: 'hidden' }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.a, 1)
  // Symbol keys are not enumerable in JSON.stringify — they're dropped
  const keys = Object.keys(data)
  assert.deepEqual(keys, ['a'], 'Symbol keys must be dropped by JSON.stringify')
})

// ── 20. Function in getData ────────────────────────────────────────────

test('hydrate: Function in getData value is dropped by JSON.stringify', async () => {
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ a: 1, fn: () => 'hello' as any }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.a, 1)
  assert.ok(!('fn' in data), 'Function values must be dropped by JSON.stringify')
})

// ── 21. Deeply nested data ─────────────────────────────────────────────

test('hydrate: deeply nested data survives serialization round-trip', async () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } }
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => deep }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal((data.a as any).b.c.d.e.f.g, 'deep')
})

// ── 22. Large array in getData ─────────────────────────────────────────

test('hydrate: large array in getData serializes correctly', async () => {
  const arr = Array.from({ length: 10000 }, (_, i) => i)
  const routes: Route[] = [{ path: '/', component: Cmp, getData: () => ({ items: arr }) }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(Array.isArray(data.items), true)
  assert.equal((data.items as number[]).length, 10000)
  assert.equal((data.items as number[])[0], 0)
  assert.equal((data.items as number[])[9999], 9999)
})

// ── 23. getData throwing async ─────────────────────────────────────────

test('hydrate: async getData throwing is caught by error path', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: async () => { throw new Error('async fail') },
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  const data = extractData(html)
  assert.equal(data.error, 'async fail', 'async getData errors must be caught')
})

// ── 24. onError returning non-object ───────────────────────────────────

test('hydrate: onError returning string is still serialized', async () => {
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: () => { throw new Error('fail') },
    onError: () => 'fallback string' as any,
  }]
  const app = createApp({ routes })
  const res = await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  const html = await res.text()
  assert.ok(html.includes('__DATA__'), 'onError string must still produce __DATA__')
})

// ── 25. Multiple beforeRender calls ────────────────────────────────────

test('hydrate: beforeRender called exactly once per request', async () => {
  let count = 0
  const routes: Route[] = [{
    path: '/', component: Cmp,
    getData: () => ({ ok: true }),
    beforeRender: () => { count++ },
  }]
  const app = createApp({ routes })
  await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  await app.fetch(new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0' } }))
  assert.equal(count, 3, 'beforeRender must be called once per request')
})