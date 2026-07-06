---
name: @project-x15/rendering-engine
description: Dual-mode SSR/CSR rendering engine for streaming apps on Hono + Preact. Targets Cloudflare Workers first, runs on Node.js, Bun, and Deno. Skills cover Hono routing, Preact SSR, Workers isolate lifecycle, Cache API, deterministic simulation testing, config cache state machine, mode detection, HTML security, and route matching.
version: 0.1.0
language: typescript
runtime:
  - cloudflare-workers
  - node
  - bun
  - deno
framework:
  - hono
  - preact
repo: https://github.com/project-x15/rendering-engine
tags:
  - ssr
  - csr
  - streaming
  - smart-tv
  - server-rendering
  - preact
  - hono
  - cloudflare-workers
---

# @project-x15/rendering-engine skills

What you need to know to work on this codebase effectively.

## Hono

The engine is a Hono app. You need to understand Hono's routing (`app.get`, `app.use`), context object (`c.req`, `c.json`, `c.html`), and middleware handler type (`MiddlewareHandler`). Hono runs on multiple runtimes (Workers, Node, Bun, Deno), which is why the engine can too.

Hono docs: https://hono.dev

## Preact SSR

Components are Preact function components. SSR uses `preact-render-to-string`'s `renderToString`. No hydration on the server side. The client bundle handles hydration for web, and full client-side rendering for TV.

You need to know: `h()` for creating elements, `ComponentType` for typing components, and the difference between Preact and React (Preact is smaller, has no synthetic events, uses different event handling).

## Cloudflare Workers runtime

The engine targets Workers first. You need to understand:

Isolate lifecycle. Workers spin up isolates that handle requests. An isolate can be killed and restarted at any time. L1 cache (in-memory) is lost on restart. L2 cache (Cache API) survives.

Cache API. `caches.default` is a key-value store for `Response` objects. Available on Workers, not on standard Node.js. The config loader uses it for L2.

`wrangler.toml`. Static assets are served via the `[assets]` config, not middleware. The engine omits `serveStatic` on Workers because of this.

`export default`. A Workers entry point exports the Hono app directly as the default export.

## Deterministic Simulation Testing

The DST suite is the most complex part of the test suite. You need to understand:

Seeded PRNG. `mulberry32` generates deterministic random numbers from a fixed integer seed. Same seed always produces the same sequence.

Operation model. Tests generate random sequences of operations (page requests, API calls, config resets, failure injections). Each operation carries signals (User-Agent, query params, cookies) that affect mode detection.

Reference model. An independent `Sim` structure mirrors the engine's config cache state machine. It predicts what the response should be for every operation. The test asserts the real response matches the model.

Reproducibility check. Every scenario runs twice from the same seed. The two traces are deep-compared. Any hidden dependency on real scheduling would break this.

Per-step invariants. Every step checks response status, body shape, `__DATA__` content, and config fetch counts. Not just final state.

Shrinking. On failure, the seed and operation list are printed so the case can be reproduced and minimized.

## Config cache state machine

You need to reason about three states: empty, pending, and cached. A request can hit L1 (cached), join an in-flight fetch (pending), or start a new fetch. Failures clear pending so retries work. `reset()` clears L1 only. L2 is populated on successful fetch and read on L1 miss.

The dedup logic is the trickiest part. Concurrent calls to `load()` share the same pending promise. The first call fetches, the rest wait. If the fetch fails, the pending promise is cleared so the next call starts fresh.

## Mode detection

Four signals checked in strict priority order. You need to know the priority and the default:

1. `?tv=1` / `?web=1` query param
2. `tv-mode=1` / `tv-mode=0` cookie
3. `Sec-CH-UA-Platform` header
4. User-Agent keyword match (tizen, webos, roku, etc.)

Default is `'ssr'`. TV signals flip to `'csr'`. A custom `detectMode` function can replace the entire detector.

## HTML security

`ssrTemplate` serializes page data as JSON inside a `<script type="application/json">` tag. The `</script>` sequence in data is escaped to `<\/script>` to prevent script injection. This is the only XSS mitigation. Any HTML passed via `headContent` is not escaped. The app is responsible for sanitizing `headContent`.

## Route matching

Split by `/`, compare segment by segment. `:param` segments capture values via `decodeURIComponent`. Malformed encoding (e.g. `%zz`) returns `null`, not an exception. Trailing slashes are normalized (removed unless root). First match wins. No wildcards, no regex, no optional params.

## AGENTS.md

All code changes follow AGENTS.md. Read it before contributing. Key rules:

Simple code over clever code. One function, one job. Comments explain why, not what. Small diffs. No abstraction with one caller. No classes when functions work. Early returns over nesting. Plain names. Delete code before adding. If a junior can't trace the flow in 2 minutes, simplify.