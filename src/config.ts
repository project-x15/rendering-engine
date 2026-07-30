import type { Logger } from './types.js'

/**
 * Config loader with two-layer cache:
 *
 *   L1: in-memory (instant, dedup concurrent requests, lost on isolate restart)
 *   L2: Cache API (caches.default, persists across isolate restarts on Workers)
 *
 * On Cloudflare Workers: L1 + L2. Isolate restart clears L1 but L2 survives.
 * On Node.js: L1 only (caches is undefined). Process persists so L1 is sufficient.
 *
 * Dedup: concurrent calls share the same pending promise (L1 only).
 *
 * Circuit breaker: after a fetch failure, the loader enters a cooldown.
 * During cooldown it fails fast instead of retrying the fetcher, then retries
 * after the cooldown elapses — preventing hammering a dead config server while
 * recovering automatically. When L2 is populated it short-circuits the fetcher
 * and serves the last-known-good config, so the breaker only governs the
 * cold-start (L2-empty) outage.
 *
 * On Cloudflare Workers, the Cache API has a 4MB per-entry limit.
 * Configs larger than 4MB will not persist across isolate restarts (L2).
 * L1 (in-memory) still works within the current isolate's lifetime.
 */

export interface ConfigLoader<T> {
  load: () => Promise<T>
  reset: () => void
}

export interface ConfigLoaderOptions {
  /** Cache key for L2 (Cache API). Default: 'https://x15-engine/config' */
  cacheKey?: string
  /**
   * L2 Cache-Control max-age (seconds) set on the stored Response. Default: 3600.
   *
   * This is a Cache API eviction hint, NOT app-level freshness: the loader
   * serves the last L2 entry until it is externally evicted; it does not
   * revalidate on age. If you need periodic refresh from origin, call reset()
   * (or clear L2 externally).
   */
  ttl?: number
  /**
   * Hard cap on config size in bytes.
   * If fetched config exceeds this, load() rejects with a size error.
   * App degrades to {} config gracefully (existing path).
   * Default: no limit.
   */
  maxConfigSize?: number
  /**
   * Timeout in ms for the fetcher.
   * If fetcher takes longer, load() rejects with a timeout error.
   * On timeout, pending is cleared so next request retries.
   * Default: no timeout.
   */
  configTimeout?: number
  /** Logger for diagnostics. Defaults to console. */
  logger?: Logger
  /**
   * Circuit breaker cooldown in ms after a config fetch failure.
   * During cooldown the loader fails fast instead of retrying the fetcher.
   * (When L2 is populated it serves the last-known-good config regardless.)
   * Set to 0 to disable (immediate retry on every request). Default: 5000.
   */
  circuitBreakerCooldownMs?: number
  /**
   * App-level freshness TTL in milliseconds.
   *
   * When set, the loader serves cached config instantly while fresh (within
   * TTL). When stale (past TTL), it serves the stale value immediately AND
   * triggers a non-blocking background refresh from origin. The caller never
   * waits for the refresh — they get the stale value instantly. The next
   * load() after the refresh completes gets the fresh value. If the
   * background refresh fails, the stale value persists.
   *
   * Default: undefined (no TTL, cache is always fresh until reset()).
   */
  configTtl?: number
}

// Cloudflare Workers extends CacheStorage with a 'default' Cache instance.
// Standard DOM lib doesn't include it, so we cast at the access point.
interface WorkerCacheStorage extends CacheStorage {
  default: Cache
}

// Cache API detection — available on Workers, not on standard Node.js
function hasCacheApi(): boolean {
  return typeof caches !== 'undefined'
}

export function createConfigLoader<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>,
  options?: ConfigLoaderOptions
): ConfigLoader<T> {
  const cacheKey = options?.cacheKey ?? 'https://x15-engine/config'
  const ttl = options?.ttl ?? 3600
  const maxConfigSize = options?.maxConfigSize
  const configTimeout = options?.configTimeout
  const logger = options?.logger ?? console
  const cooldownMs = options?.circuitBreakerCooldownMs ?? 5_000

  let cached: T | null = null
  let pending: Promise<T> | null = null
  let cachedAt = 0

  const COOLDOWN_MS = cooldownMs
  let failureCount = 0
  let lastFailureTime = 0

  const freshnessTtl = options?.configTtl

  async function loadFromCacheApi(): Promise<T | null> {
    if (!hasCacheApi()) return null
    const res = await (caches as WorkerCacheStorage).default.match(cacheKey)
    if (!res) return null
    return res.json() as Promise<T>
  }

  async function storeInCacheApi(config: T): Promise<void> {
    if (!hasCacheApi()) return

    // Warn when config approaches Workers Cache API 4MB limit
    const json = JSON.stringify(config)
    const sizeBytes = new TextEncoder().encode(json).length
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2)
    if (sizeBytes > 3_000_000) {
      logger.warn(
        'config: size exceeds 3MB — Cache API (L2) may reject entries >4MB',
        { sizeMB: Number(sizeMB) }
      )
    }

    const res = new Response(json, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=' + ttl,
      },
    })
    await (caches as WorkerCacheStorage).default.put(cacheKey, res)
  }

  // Circuit breaker: fail fast during cooldown, then retry after it expires.
  // When L2 (Cache API) is populated it short-circuits the fetcher in load()
  // before this runs, so the breaker only governs the cold-start (L2-empty)
  // outage — fail fast instead of hammering a dead config server, then retry
  // once the cooldown elapses.
  async function checkCircuitBreaker(): Promise<null> {
    if (failureCount === 0) return null
    const elapsed = Date.now() - lastFailureTime
    if (elapsed >= COOLDOWN_MS) {
      failureCount = 0
      return null
    }
    throw new Error(
      `config: fetcher is in cooldown (${Math.round((COOLDOWN_MS - elapsed) / 1000)}s remaining) ` +
      `after ${failureCount} failure(s)`
    )
  }

  // Fetch from origin with optional timeout via AbortController.
  // The signal is passed to the fetcher so it can cancel the underlying
  // request (e.g. fetch(url, { signal })). If the fetcher ignores the
  // signal, the race still rejects — but the fetcher keeps running.
  // Fetchers that respect the signal get proper resource cleanup.
  async function fetchFromOrigin(): Promise<T> {
    if (configTimeout !== undefined) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), configTimeout)
      try {
        return await Promise.race([
          fetcher(controller.signal),
          new Promise<T>((_, reject) => {
            controller.signal.addEventListener('abort', () => {
              reject(new Error(`config: fetcher timed out after ${configTimeout}ms`))
            })
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    return fetcher()
  }

  function checkSize(config: T): void {
    if (maxConfigSize === undefined) return
    const json = JSON.stringify(config)
    const sizeBytes = new TextEncoder().encode(json).length
    if (sizeBytes <= maxConfigSize) return
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2)
    const limitMB = (maxConfigSize / 1024 / 1024).toFixed(2)
    throw new Error(
      `config: size ${sizeMB}MB (${sizeBytes} bytes) exceeds ` +
      `maxConfigSize of ${limitMB}MB (${maxConfigSize} bytes)`
    )
  }

  // Background refresh: fetch from origin without blocking the caller.
  // Used by stale-while-revalidate when configTtl is set and the L1 cache
  // is stale. Skips L2 (it holds the same stale value). Respects the circuit
  // breaker. On success updates L1 + L2 + cachedAt. On failure records the
  // breaker failure but the stale L1 value persists.
  function refreshInBackground(): void {
    if (pending !== null) return // already fetching or refreshing
    pending = (async () => {
      await checkCircuitBreaker()
      try {
        const config = await fetchFromOrigin()
        checkSize(config)
        storeInCacheApi(config).catch((err) => logger.warn('config: L2 cache write failed', { error: err }))
        cached = config
        cachedAt = Date.now()
        return config
      } catch (err) {
        failureCount++
        lastFailureTime = Date.now()
        throw err
      }
    })()
    pending.then(() => { pending = null }, () => { pending = null })
  }

  function load(): Promise<T> {
    if (cached !== null) {
      // Stale-while-revalidate: if past TTL, serve stale + refresh in background
      if (freshnessTtl !== undefined && Date.now() - cachedAt >= freshnessTtl) {
        refreshInBackground()
      }
      return Promise.resolve(cached)
    }
    if (pending !== null) return pending

    pending = (async () => {
      // Fail fast during cooldown (cold-start outage, L2 empty). When L2 is
      // populated it short-circuits below before the fetcher runs.
      await checkCircuitBreaker()

      try {
        // L2: Cache API (survives isolate restart on Workers)
        const fromCache = await loadFromCacheApi()
        if (fromCache !== null) {
          cached = fromCache
          cachedAt = Date.now()
          return fromCache
        }

        const config = await fetchFromOrigin()

        checkSize(config)

        // Store in L2 (Cache API) — fire and forget, but surface failures
        storeInCacheApi(config).catch((err) => logger.warn('config: L2 cache write failed', { error: err }))

        cached = config
        cachedAt = Date.now()
        return config
      } catch (err) {
        // Record the failure so the breaker fails fast on the next request
        // during cooldown. Last-known-good serving during outages is handled
        // by the L2 short-circuit above, not here.
        failureCount++
        lastFailureTime = Date.now()
        throw err
      }
    })()

    // Clear the in-flight slot once it settles so the next load proceeds (and
    // rechecks cache/breaker) instead of deduping onto a settled promise. Done
    // in one place rather than at every return/throw inside the IIFE.
    pending.then(() => { pending = null }, () => { pending = null })
    return pending
  }

  function reset(): void {
    // Clears L1 only. L2 (Cache API) expires via TTL or is overwritten on next fetch.
    cached = null
    pending = null
    cachedAt = 0
  }

  return { load, reset }
}