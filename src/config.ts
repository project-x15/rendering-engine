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
 * Circuit breaker: after a fetch failure, the loader enters a 5-second cooldown.
 * During cooldown, stale L2 data is served if available. After cooldown,
 * the next request retries the fetcher. This prevents hammering a dead config
 * server while still recovering automatically when it comes back.
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
  /** L2 Cache-Control max-age in seconds. Default: 3600 */
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
   * Circuit breaker cooldown in ms after a fetch failure.
   * During cooldown, stale L2 cache is served if available.
   * Set to 0 to disable (immediate retry on every request).
   * Default: 5000.
   */
  circuitBreakerCooldownMs?: number
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

  // Circuit breaker state
  const COOLDOWN_MS = cooldownMs
  let failureCount = 0
  let lastFailureTime = 0

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
        `config: size ${sizeMB}MB exceeds 3MB — ` +
        `Cache API (L2) may reject entries >4MB`
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

  // Circuit breaker: if in cooldown, serve stale L2 or fail fast.
  // Returns stale data if served, or null to proceed with a fresh fetch.
  async function checkCircuitBreaker(): Promise<T | null> {
    if (failureCount === 0) return null
    const elapsed = Date.now() - lastFailureTime
    if (elapsed >= COOLDOWN_MS) {
      failureCount = 0
      return null
    }
    const stale = await loadFromCacheApi()
    if (stale !== null) {
      logger.warn(
        `config: in cooldown (${Math.round((COOLDOWN_MS - elapsed) / 1000)}s), ` +
        `serving stale L2 cache`
      )
      cached = stale
      pending = null
      return stale
    }
    pending = null
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

  // Check config size against maxConfigSize limit. Throws if exceeded.
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

  function load(): Promise<T> {
    if (cached !== null) return Promise.resolve(cached)
    if (pending !== null) return pending

    pending = (async () => {
      // Circuit breaker: if in cooldown, serve stale or fail fast
      const breakerResult = await checkCircuitBreaker()
      if (breakerResult !== null) return breakerResult

      try {
        // L2: Cache API (survives isolate restart on Workers)
        const fromCache = await loadFromCacheApi()
        if (fromCache !== null) {
          cached = fromCache
          pending = null
          return fromCache
        }

        // Cache miss — fetch from origin
        const config = await fetchFromOrigin()

        // Check maxConfigSize after fetch, before storing in cache
        checkSize(config)

        // Store in L2 (Cache API) — fire and forget, but surface failures
        storeInCacheApi(config).catch((err) => logger.warn('config: L2 cache write failed', err))

        cached = config
        pending = null
        return config
      } catch (err) {
        // Circuit breaker: record failure, try stale L2 before giving up
        failureCount++
        lastFailureTime = Date.now()

        const stale = await loadFromCacheApi()
        if (stale !== null) {
          logger.warn('config: fetch failed, serving stale L2 cache', err)
          cached = stale
          pending = null
          return stale
        }

        // No stale data — clear pending so next request retries
        pending = null
        throw err
      }
    })()

    return pending
  }

  function reset(): void {
    // Clears L1 only. L2 (Cache API) expires via TTL or is overwritten on next fetch.
    cached = null
    pending = null
  }

  return { load, reset }
}