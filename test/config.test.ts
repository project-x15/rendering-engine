import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConfigLoader } from '../src/config.js'

// ── In-memory cache (L1) — works on all platforms ──

test('configLoader: first call fetches and caches', async () => {
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return { theme: 'dark' } })
  const config = await loader.load()
  assert.equal(calls, 1)
  assert.deepEqual(config, { theme: 'dark' })
})

test('configLoader: subsequent calls use cache (no refetch)', async () => {
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return { theme: 'dark' } })
  await loader.load()
  await loader.load()
  await loader.load()
  assert.equal(calls, 1)
})

test('configLoader: concurrent calls deduped (single fetch)', async () => {
  let calls = 0
  const loader = createConfigLoader(async () => {
    calls++
    return new Promise((resolve) => setTimeout(() => resolve({ theme: 'dark' }), 10))
  })
  const [a, b, c] = await Promise.all([loader.load(), loader.load(), loader.load()])
  assert.equal(calls, 1)
  assert.deepEqual(a, { theme: 'dark' })
  assert.deepEqual(b, { theme: 'dark' })
  assert.deepEqual(c, { theme: 'dark' })
})

test('configLoader: reset clears L1 so next load refetches', async () => {
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return { v: calls } })
  await loader.load()
  loader.reset()
  await loader.load()
  assert.equal(calls, 2)
})

test('configLoader: fetch error does not cache failure', async () => {
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; throw new Error('down') }, {
    circuitBreakerCooldownMs: 0,
  })
  await assert.rejects(() => loader.load(), { message: 'down' })
  await assert.rejects(() => loader.load(), { message: 'down' })
  assert.equal(calls, 2)
})

// ── Cache API (L2) — persists across isolate restarts on Workers ──

function mockCacheApi(): { cleanup: () => void } {
  const store = new Map<string, Response>()
  ;(globalThis as any).caches = {
    default: {
      // put stores Response synchronously so the test can read it immediately
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
  return {
    cleanup: () => { delete (globalThis as any).caches; store.clear() },
  }
}

test('configLoader: L2 (Cache API) survives isolate restart', async () => {
  const mock = mockCacheApi()
  try {
    let calls = 0
    const loader = createConfigLoader(async () => { calls++; return { theme: 'dark' } })

    // First load — fetches and populates L1 + L2
    await loader.load()
    assert.equal(calls, 1)

    // Simulate isolate restart: clear L1 only
    loader.reset()

    // Second load — L1 is empty, but L2 (Cache API) has the value
    const config = await loader.load()
    assert.equal(calls, 1, 'should use L2 cache, not refetch')
    assert.deepEqual(config, { theme: 'dark' })
  } finally {
    mock.cleanup()
  }
})

test('configLoader: without Cache API, reset forces refetch', async () => {
  // Ensure no leaked caches from previous tests
  delete (globalThis as any).caches

  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return { theme: 'dark' } })

  await loader.load()
  loader.reset()
  await loader.load()
  assert.equal(calls, 2, 'without L2, reset forces refetch')
})
test('configLoader: L2 store failure is swallowed (covers .catch arrow)', async () => {
  const mock = mockCacheApi()
  // Override put to reject — storeInCacheApi throws, the fire-and-forget .catch
  // must swallow it so load() still resolves with the fetched config.
  ;(globalThis as any).caches.default.put = () => Promise.reject(new Error('cache write failed'))
  try {
    let calls = 0
    const loader = createConfigLoader(async () => { calls++; return { theme: 'dark' } })
    const config = await loader.load()
    assert.deepEqual(config, { theme: 'dark' })
    assert.equal(calls, 1, 'fetcher ran despite cache write failure')
    // L1 still populated — second load must not refetch
    await loader.load()
    assert.equal(calls, 1)
  } finally {
    mock.cleanup()
    // restore a non-rejecting mock shape not needed; cleanup deletes caches
  }
})
