import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ssrTemplate, csrShell } from '../src/html.js'
import { captureConsoleWarn } from './helpers.js'

test('ssrTemplate: wraps rendered HTML in #app', () => {
  const html = ssrTemplate({ html: '<p>hi</p>', data: {}, cssPath: '/a.css', jsPath: '/b.js' })
  assert.ok(html.includes('<div id="app" data-ssr="true"><p>hi</p></div>'))
})

test('ssrTemplate: serializes data in __DATA__', () => {
  const html = ssrTemplate({ html: '', data: { x: 1 }, cssPath: '/a.css', jsPath: '/b.js' })
  assert.ok(html.includes('__DATA__'))
  assert.ok(html.includes('{"x":1}'))
})

test('ssrTemplate: includes CSS and JS links', () => {
  const html = ssrTemplate({ html: '', data: {}, cssPath: '/style.css', jsPath: '/app.js' })
  assert.ok(html.includes('href="/style.css"'))
  assert.ok(html.includes('src="/app.js"'))
})

test('ssrTemplate: includes title when provided', () => {
  const html = ssrTemplate({ html: '', data: {}, cssPath: '/a.css', jsPath: '/b.js', title: 'My Show' })
  assert.ok(html.includes('<title>My Show</title>'))
})

test('ssrTemplate: omits title tag when not provided', () => {
  const html = ssrTemplate({ html: '', data: {}, cssPath: '/a.css', jsPath: '/b.js' })
  assert.ok(!html.includes('<title>'))
})

test('ssrTemplate: injects headContent into head', () => {
  const html = ssrTemplate({
    html: '', data: {}, cssPath: '/a.css', jsPath: '/b.js',
    headContent: '<meta name="theme-color" content="#ff0000">',
  })
  assert.ok(html.includes('<meta name="theme-color" content="#ff0000">'))
})

test('ssrTemplate: escapes </script> in data to prevent XSS', () => {
  const html = ssrTemplate({ html: '', data: { x: '</script><script>alert(1)' }, cssPath: '/a.css', jsPath: '/b.js' })
  assert.ok(!html.includes('</script><script>alert'))
  assert.ok(html.includes('<\\/script>'))
})

test('ssrTemplate: no API key in output', () => {
  const html = ssrTemplate({ html: '', data: {}, cssPath: '/a.css', jsPath: '/b.js' })
  assert.ok(!html.includes('api_key'))
})

test('csrShell: has empty #app div', () => {
  const html = csrShell({ cssPath: '/tv.css', jsPath: '/tv.js' })
  assert.ok(html.includes('<div id="app"></div>'))
})

test('csrShell: has tv-mode body class', () => {
  const html = csrShell({ cssPath: '/tv.css', jsPath: '/tv.js' })
  assert.ok(html.includes('tv-mode'))
})

test('csrShell: includes TV CSS and JS', () => {
  const html = csrShell({ cssPath: '/tv/style.css', jsPath: '/tv/app.js' })
  assert.ok(html.includes('href="/tv/style.css"'))
  assert.ok(html.includes('src="/tv/app.js"'))
})

test('csrShell: no __DATA__ script tag', () => {
  const html = csrShell({ cssPath: '/tv.css', jsPath: '/tv.js' })
  assert.ok(!html.includes('__DATA__'))
})

test('csrShell: injects headContent into head', () => {
  const html = csrShell({
    cssPath: '/tv.css', jsPath: '/tv.js',
    headContent: '<meta name="theme-color" content="#ff0000">',
  })
  assert.ok(html.includes('<meta name="theme-color" content="#ff0000">'))
})

// ── dev option (replaces process.env.NODE_ENV sniffing) ──────────────────
//
// The large-__DATA__ warning is gated on an explicit `dev` flag, not on
// process.env.NODE_ENV. This keeps html.ts environment-agnostic — the only
// runtime-environment check in the codebase is removed.

const big = { x: 'a'.repeat(150_000) } // ~150KB — over the 100KB warn threshold

test('ssrTemplate: dev:true warns when __DATA__ exceeds threshold', () => {
  const cap = captureConsoleWarn()
  try {
    ssrTemplate({ html: '', data: big, cssPath: '/a.css', jsPath: '/b.js', dev: true, routePath: '/big' })
    const warned = cap.messages.some((m) => /SSR __DATA__ is/.test(m))
    assert.ok(warned, 'dev:true should warn on large __DATA__')
  } finally {
    cap.restore()
  }
})

test('ssrTemplate: dev:false does not warn (no env sniffing)', () => {
  const cap = captureConsoleWarn()
  try {
    ssrTemplate({ html: '', data: big, cssPath: '/a.css', jsPath: '/b.js', dev: false, routePath: '/big' })
    const warned = cap.messages.some((m) => /SSR __DATA__ is/.test(m))
    assert.ok(!warned, 'dev:false must not warn regardless of NODE_ENV')
  } finally {
    cap.restore()
  }
})

test('ssrTemplate: dev unset does not warn (default off, env-agnostic)', () => {
  const cap = captureConsoleWarn()
  try {
    ssrTemplate({ html: '', data: big, cssPath: '/a.css', jsPath: '/b.js', routePath: '/big' })
    const warned = cap.messages.some((m) => /SSR __DATA__ is/.test(m))
    assert.ok(!warned, 'no dev option → no warning (env-agnostic)')
  } finally {
    cap.restore()
  }
})

test('ssrTemplate: maxDataSize hard cap throws regardless of dev', () => {
  // The hard cap is independent of dev — it protects production responses.
  const cap = captureConsoleWarn()
  try {
    assert.throws(
      () => ssrTemplate({ html: '', data: big, cssPath: '/a.css', jsPath: '/b.js', dev: false, maxDataSize: 1024, routePath: '/big' }),
      /exceeds limit/,
    )
  } finally {
    cap.restore()
  }
})

test('ssrTemplate: dev:true with large data and no routePath uses "?" fallback', () => {
  // Covers the opts.routePath ?? '?' branch inside the dev warning path.
  const cap = captureConsoleWarn()
  try {
    ssrTemplate({ html: '', data: big, cssPath: '/a.css', jsPath: '/b.js', dev: true })
    const warned = cap.messages.some((m) => /SSR __DATA__ is.*\?/.test(m))
    assert.ok(warned, 'warning should use "?" when routePath is omitted')
  } finally {
    cap.restore()
  }
})

test('ssrTemplate: maxDataSize set with data under limit does not throw', () => {
  // Covers the false branch of the maxDataSize check: limit is set but
  // data is small enough — must return HTML, not throw.
  const html = ssrTemplate({ html: '<p>ok</p>', data: { x: 1 }, cssPath: '/a.css', jsPath: '/b.js', maxDataSize: 10000, routePath: '/small' })
  assert.ok(html.includes('<p>ok</p>'))
})