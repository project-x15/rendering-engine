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
 */

export interface ConfigLoader<T> {
  load: () => Promise<T>
  reset: () => void
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
  fetcher: () => Promise<T>,
  cacheKey = 'https://x15-engine/config',
  ttl = 3600
): ConfigLoader<T> {
  let cached: T | null = null
  let pending: Promise<T> | null = null

  async function loadFromCacheApi(): Promise<T | null> {
    if (!hasCacheApi()) return null
    const res = await (caches as WorkerCacheStorage).default.match(cacheKey)
    if (!res) return null
    return res.json() as Promise<T>
  }

  async function storeInCacheApi(config: T): Promise<void> {
    if (!hasCacheApi()) return
    const res = new Response(JSON.stringify(config), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=' + ttl,
      },
    })
    await (caches as WorkerCacheStorage).default.put(cacheKey, res)
  }

  function load(): Promise<T> {
    // L1: in-memory (instant + dedup)
    if (cached !== null) return Promise.resolve(cached)
    if (pending !== null) return pending

    pending = (async () => {
      try {
        // L2: Cache API (survives isolate restart on Workers)
        const fromCache = await loadFromCacheApi()
        if (fromCache !== null) {
          cached = fromCache
          pending = null
          return fromCache
        }

        // Cache miss — fetch from origin
        const config = await fetcher()

        // Store in L2 (Cache API) — fire and forget, but surface failures
        storeInCacheApi(config).catch((err) => console.warn('config: L2 cache write failed', err))

        // Store in L1 (in-memory)
        cached = config
        pending = null
        return config
      } catch (err) {
        // Clear pending so next load() retries instead of returning stale rejection
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