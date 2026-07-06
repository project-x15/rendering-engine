import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ssrTemplate, csrShell } from '../src/html.js'

test('ssrTemplate: wraps rendered HTML in #app', () => {
  const html = ssrTemplate({ html: '<p>hi</p>', data: {}, cssPath: '/a.css', jsPath: '/b.js' })
  assert.ok(html.includes('<div id="app"><p>hi</p></div>'))
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