import { test, expect } from '@playwright/test'

// ═══════════════════════════════════════════════════════════════════════
//  E2E / Browser Tests (Playwright) — ~20 essential tests
//  Real browser, real HTTP server. Covers the full pipeline.
// ═══════════════════════════════════════════════════════════════════════

test.describe('rendering engine e2e', () => {

  // ── SSR ──

  test('SSR page renders with data', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('content')).toHaveText('Hello World')
    await expect(page).toHaveTitle('E2E Test')
    const data = await page.evaluate(() => {
      const el = document.getElementById('__DATA__')
      return el ? JSON.parse(el.textContent || '{}') : null
    })
    expect(data).toEqual({ title: 'Home', items: [1, 2, 3] })
  })

  test('SSR page with params', async ({ page }) => {
    await page.goto('/show/42')
    const data = await page.evaluate(() => {
      const el = document.getElementById('__DATA__')
      return el ? JSON.parse(el.textContent || '{}') : null
    })
    expect(data).toEqual({ id: '42', title: 'Show 42' })
  })

  test('SSR page with no getData produces empty __DATA__', async ({ page }) => {
    await page.goto('/static')
    const data = await page.evaluate(() => {
      const el = document.getElementById('__DATA__')
      return el ? JSON.parse(el.textContent || '{}') : null
    })
    expect(data).toEqual({})
  })

  test('SSR error page renders with onError data', async ({ page }) => {
    await page.goto('/fail')
    const data = await page.evaluate(() => {
      const el = document.getElementById('__DATA__')
      return el ? JSON.parse(el.textContent || '{}') : null
    })
    expect(data).toEqual({ error: 'getData exploded', recovered: true })
  })

  test('SSR has correct CSS and JS assets', async ({ page }) => {
    await page.goto('/')
    const css = await page.locator('link[rel="stylesheet"]').getAttribute('href')
    const js = await page.locator('script[src]').first().getAttribute('src')
    expect(css).toBe('/web/assets/style.css')
    expect(js).toBe('/web/assets/client.js')
  })

  // ── SSR abandonment ──

  test('SSR #app has data-ssr="true" and data-ssr-url', async ({ page }) => {
    await page.goto('/show/42')
    const ssr = await page.evaluate(() => document.getElementById('app')?.getAttribute('data-ssr'))
    const url = await page.evaluate(() => document.getElementById('app')?.getAttribute('data-ssr-url'))
    expect(ssr).toBe('true')
    expect(url).toBe('/api/data/show/42')
  })

  test('CSR shell does NOT have data-ssr attribute', async ({ page }) => {
    await page.goto('/?tv=1')
    const ssr = await page.evaluate(() => document.getElementById('app')?.getAttribute('data-ssr'))
    expect(ssr).toBeNull()
  })

  test('data-ssr-url resolves to same data as __DATA__', async ({ page }) => {
    await page.goto('/show/42')
    const ssrData = await page.evaluate(() => {
      const el = document.getElementById('__DATA__')
      return el ? JSON.parse(el.textContent || '{}') : null
    })
    const apiUrl = await page.evaluate(() => document.getElementById('app')?.getAttribute('data-ssr-url'))
    const apiData = await page.evaluate(async (url) => {
      const res = await fetch('http://localhost:3157' + url!)
      return res.json()
    }, apiUrl)
    expect(apiData).toEqual(ssrData)
  })

  // ── CSR mode detection ──

  test('CSR via ?tv=1 returns empty shell', async ({ page }) => {
    await page.goto('/?tv=1')
    const hasData = await page.evaluate(() => !!document.getElementById('__DATA__'))
    expect(hasData).toBe(false)
    const appHtml = await page.evaluate(() => document.getElementById('app')?.innerHTML)
    expect(appHtml).toBe('')
  })

  test('CSR via TV user-agent', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'user-agent': 'Mozilla/5.0 (Tizen 2.4)' })
    await page.goto('/')
    const hasData = await page.evaluate(() => !!document.getElementById('__DATA__'))
    expect(hasData).toBe(false)
  })

  test('?web=1 forces SSR even with TV UA', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'user-agent': 'Mozilla/5.0 (Tizen 2.4)' })
    await page.goto('/?web=1')
    const hasData = await page.evaluate(() => !!document.getElementById('__DATA__'))
    expect(hasData).toBe(true)
  })

  // ── /api/data ──

  test('/api/data returns JSON', async ({ page }) => {
    const response = await page.goto('/api/data/')
    expect(response!.status()).toBe(200)
    expect(await response!.json()).toEqual({ title: 'Home', items: [1, 2, 3] })
  })

  test('/api/data/unknown returns 404', async ({ page }) => {
    const response = await page.goto('/api/data/unknown')
    expect(response!.status()).toBe(404)
  })

  test('/api/data/fail returns 500', async ({ page }) => {
    const response = await page.goto('/api/data/fail')
    expect(response!.status()).toBe(500)
  })

  // ── /api/config ──

  test('/api/config returns cached config', async ({ page }) => {
    await page.goto('/')
    const response = await page.evaluate(() => fetch('http://localhost:3157/api/config').then(r => r.json()))
    expect(response).toEqual({ theme: 'dark', version: 1 })
  })

  // ── /tv ──

  test('/tv serves CSR shell', async ({ page }) => {
    await page.goto('/tv')
    const hasData = await page.evaluate(() => !!document.getElementById('__DATA__'))
    expect(hasData).toBe(false)
  })

  // ── Headers & security ──

  test('x-request-id is propagated', async ({ page }) => {
    const response = await page.request.get('http://localhost:3157/', {
      headers: { 'x-request-id': 'custom-id-123' },
    })
    expect(response.headers()['x-request-id']).toBe('custom-id-123')
  })

  test('__DATA__ is application/json (not executable)', async ({ page }) => {
    await page.goto('/')
    const type = await page.evaluate(() => document.getElementById('__DATA__')?.getAttribute('type'))
    expect(type).toBe('application/json')
  })

  test('no secrets in HTML source', async ({ page }) => {
    const response = await page.goto('/')
    const html = await response!.text()
    expect(html).not.toContain('api_key')
    expect(html).not.toContain('secret')
    expect(html).not.toContain('password')
  })

  // ── 404 ──

  test('unknown route returns 404', async ({ page }) => {
    const response = await page.goto('/unknown-route')
    expect(response!.status()).toBe(404)
  })
})