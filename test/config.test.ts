import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConfigLoader } from '../src/config.js'
import { mockCacheApi } from './helpers.js'

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

// ── Circuit breaker (cooldown > 0) ─────────────────────────────────────
//
// The breaker's only observable behavior is fail-fast-during-cooldown when
// L2 is empty (cold-start outage), then retry after cooldown. When L2 is
// populated it short-circuits the fetcher and serves the last-known-good
// config indefinitely — that path is covered by the L2 tests above. These
// tests lock in the cold-start outage behavior so the upcoming cleanup of
// the dead stale-serve code cannot regress it.

// ── configTtl — stale-while-revalidate ─────────────────────────────

test('configTtl: serves cached within TTL (no refetch)', async () => {
  delete (globalThis as any).caches
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return { v: calls } }, {
    configTtl: 1000,
  })
  await loader.load()
  await loader.load()
  assert.equal(calls, 1, 'within TTL, must not refetch')
})

test('configTtl: serves stale + background refetches after TTL expires', async () => {
  delete (globalThis as any).caches
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return { v: calls } }, {
    configTtl: 100,
  })
  const first = await loader.load()
  assert.equal(first.v, 1)
  assert.equal(calls, 1)

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, 150))

  // Stale: serves old value immediately, triggers background refetch
  const stale = await loader.load()
  assert.equal(stale.v, 1, 'must serve stale value immediately')

  // Wait for background refetch to complete
  await new Promise((r) => setTimeout(r, 50))

  // Cache was refreshed ~50ms ago, TTL is 100ms — still fresh, no new refetch
  const fresh = await loader.load()
  assert.equal(fresh.v, 2, 'background refetch must update cache')
  assert.equal(calls, 2)
})

test('configTtl: background refetch failure keeps stale value', async () => {
  delete (globalThis as any).caches
  let calls = 0
  let broken = false
  const loader = createConfigLoader(async () => {
    calls++
    if (broken) throw new Error('down')
    return { v: calls }
  }, {
    configTtl: 30,
    circuitBreakerCooldownMs: 0,
  })

  await loader.load()
  await new Promise((r) => setTimeout(r, 50))

  broken = true
  const stale = await loader.load()
  assert.equal(stale.v, 1, 'serves stale when refetch will fail')

  await new Promise((r) => setTimeout(r, 50))

  const stillStale = await loader.load()
  assert.equal(stillStale.v, 1, 'stale value persists after refetch failure')
})

test('configTtl: undefined (default) never triggers background refetch', async () => {
  delete (globalThis as any).caches
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; return { v: calls } })
  await loader.load()
  await new Promise((r) => setTimeout(r, 50))
  await loader.load()
  assert.equal(calls, 1, 'without TTL, cache is never stale')
})

test('configTtl: background refetch dedups (single fetch for concurrent stale reads)', async () => {
  delete (globalThis as any).caches
  let calls = 0
  const loader = createConfigLoader(async () => {
    calls++
    return new Promise((resolve) => setTimeout(() => resolve({ v: calls }), 20))
  }, { configTtl: 30 })

  await loader.load()
  await new Promise((r) => setTimeout(r, 50))

  // Two concurrent stale reads — both serve stale, single background refetch
  const [a, b] = await Promise.all([loader.load(), loader.load()]) as [{ v: number }, { v: number }]
  assert.equal(a.v, 1)
  assert.equal(b.v, 1)

  await new Promise((r) => setTimeout(r, 50))
  assert.equal(calls, 2, 'only one background refetch')
})

test('breaker: fail-fast during cooldown when L2 empty (no refetch)', async () => {
  delete (globalThis as any).caches
  let calls = 0
  const loader = createConfigLoader(async () => { calls++; throw new Error('down') }, {
    circuitBreakerCooldownMs: 5000,
  })
  await assert.rejects(() => loader.load(), { message: 'down' }) // calls=1, failureCount=1
  // Second call within cooldown: breaker throws without re-invoking the fetcher.
  await assert.rejects(() => loader.load(), /in cooldown/)
  assert.equal(calls, 1, 'breaker must fail-fast; fetcher not re-invoked during cooldown')
})

test('breaker: retries origin after cooldown expires (L2 empty)', async () => {
  delete (globalThis as any).caches
  let calls = 0
  let broken = true
  const loader = createConfigLoader(async () => {
    calls++
    if (broken) throw new Error('down')
    return { v: calls }
  }, { circuitBreakerCooldownMs: 40 })
  await assert.rejects(() => loader.load(), { message: 'down' }) // calls=1
  await assert.rejects(() => loader.load(), /in cooldown/)    // calls=1
  await new Promise((r) => setTimeout(r, 50))                 // cooldown expires
  broken = false
  const cfg = await loader.load()
  assert.equal(calls, 2, 'after cooldown, fetcher must retry')
  assert.deepEqual(cfg, { v: 2 })
})
