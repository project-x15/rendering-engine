import { test } from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'preact'
import { createApp } from '../src/app.js'
import type { Route } from '../src/types.js'

// Targeted tests that close the branch-coverage gaps in src/app.ts.
// The existing suite always supplies title/headContent/getEnv/configLoader and
// every default-`??` option; these tests exercise the OMITTED (fallback) arms and
// the PROVIDED (override) arms so every branch is hit in both directions.

const Tag = () => h('div', { 'data-route': 'min' }, 'MIN')

function extractData(html: string): unknown {
  const m = html.match(/<script id="__DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  assert.ok(m, 'expected a __DATA__ script tag')
  // ssrTemplate escapes </script> -> <\/script>; undo for parsing
  return JSON.parse(m![1].replace(/<\\\/script>/g, '</script>'))
}

// ── All options OMITTED → every `??` default arm + no-getEnv/no-config/no-getData ──

test('defaults: fully-omitted options fall back to defaults and render {}', async () => {
  const route: Route = { path: '/', component: Tag } // no getData, beforeRender, onError
  const app = createApp({ routes: [route] }) // minimal: everything omitted

  // SSR (web UA) with no configLoader, no getEnv, no title
  const res = await app.fetch(
    new Request('http://localhost/', { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' } }),
  )
  const html = await res.text()
  assert.equal(res.status, 200)
  assert.ok(html.includes('__DATA__'))
  assert.ok(!html.includes('<title>'), 'no <title> tag when title omitted')
  assert.ok(html.includes('/web/assets/style.css'), 'default webCssPath used')
  assert.ok(html.includes('/web/assets/client.js'), 'default webJsPath used')
  assert.ok(!html.includes('<meta name="test"'), 'no headContent when omitted')
  assert.deepEqual(extractData(html), {}, 'route with no getData resolves to {}')
})

test('defaults: omitted configLoader → /api/config returns 404 (route not registered)', async () => {
  const app = createApp({ routes: [{ path: '/', component: Tag }] })
  const res = await app.fetch(new Request('http://localhost/api/config'))
  assert.equal(res.status, 404, '/api/config must not be registered without configLoader')
})

test('defaults: omitted configLoader → /api/data still works with config={}', async () => {
  const route: Route = { path: '/x', component: Tag } // no getData
  const app = createApp({ routes: [route] })
  const res = await app.fetch(new Request('http://localhost/api/data/x'))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), {}, 'no getData + no configLoader → {}')
})

test('defaults: omitted getEnv → ctx.env is {} (covers resolveEnv falsy arm)', async () => {
  const route: Route = {
    path: '/env',
    component: Tag,
    getData: (ctx) => ({ hasEnv: Object.keys(ctx.env).length > 0 }),
  }
  const app = createApp({ routes: [route] }) // no getEnv
  const res = await app.fetch(
    new Request('http://localhost/env', { headers: { 'user-agent': 'Mozilla/5.0' } }),
  )
  const html = await res.text()
  assert.deepEqual(extractData(html), { hasEnv: false })
})

// ── All asset/path options PROVIDED → every `??` override arm ──

test('defaults: provided tvPath + tv asset paths are used for CSR shell', async () => {
  const app = createApp({
    routes: [{ path: '/', component: Tag, getData: () => ({ ok: true }) }],
    tvPath: '/television',
    tvCssPath: '/tv.css',
    tvJsPath: '/tv.js',
    detectMode: () => 'csr', // custom detectMode → override arm
  })
  const r1 = await app.fetch(new Request('http://localhost/'))
  const b1 = await r1.text()
  assert.ok(b1.includes('/tv.css'))
  assert.ok(b1.includes('/tv.js'))
  assert.ok(b1.includes('<div id="app"></div>'))

  // direct tvPath serves CSR shell with TV asset paths
  const r2 = await app.fetch(new Request('http://localhost/television'))
  const b2 = await r2.text()
  assert.ok(b2.includes('/tv.css'))
  assert.ok(b2.includes('/tv.js'))
})

test('defaults: provided web asset paths + title are used for SSR', async () => {
  const app = createApp({
    routes: [{ path: '/', component: Tag, getData: () => ({ ok: true }) }],
    detectMode: () => 'ssr',
    webCssPath: '/w.css',
    webJsPath: '/w.js',
    title: 'T',
    headContent: '<meta name="x" content="y">',
    assetsRoot: './public',
  })
  const res = await app.fetch(new Request('http://localhost/'))
  const html = await res.text()
  assert.ok(html.includes('/w.css'))
  assert.ok(html.includes('/w.js'))
  assert.ok(html.includes('<title>T</title>'))
  assert.ok(html.includes('<meta name="x" content="y">'))
  assert.ok(html.includes('__DATA__'))
})

// ── Error path with NO onError and NO beforeRender → { error } fallback ──

test('defaults: error with no onError and no beforeRender → {error} fallback', async () => {
  const route: Route = {
    path: '/fail',
    component: Tag,
    getData: () => { throw new Error('boom') },
  }
  const app = createApp({ routes: [route] })
  const res = await app.fetch(
    new Request('http://localhost/fail', { headers: { 'user-agent': 'Mozilla/5.0' } }),
  )
  const html = await res.text()
  assert.equal(res.status, 200) // SSR error fallback still returns HTML
  assert.deepEqual(extractData(html), { error: 'boom' })
})