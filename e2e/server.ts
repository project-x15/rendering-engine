import { serve } from '@hono/node-server'
import { h } from 'preact'
import { createApp } from '../src/app.js'
import type { Route, RequestContext } from '../src/types.js'

// ── Components ─────────────────────────────────────────────────────────

const Home = () => h('div', { 'data-testid': 'content' }, 'Hello World')
const Show = () => h('div', { 'data-testid': 'show' }, 'Show Page')
const Watch = () => h('div', { 'data-testid': 'watch' }, 'Watch Page')
const Static = () => h('div', { 'data-testid': 'static' }, 'Static Page')
const Erroring = () => h('div', { 'data-testid': 'error' }, 'Error Page')
const Guarded = () => h('div', { 'data-testid': 'guarded' }, 'Guarded Page')

// ── Routes ─────────────────────────────────────────────────────────────

let beforeRenderCount = 0

const routes: Route[] = [
  {
    path: '/',
    component: Home,
    getData: () => ({ title: 'Home', items: [1, 2, 3] }),
  },
  {
    path: '/show/:id',
    component: Show,
    getData: (ctx) => ({ id: ctx.params.id, title: `Show ${ctx.params.id}` }),
  },
  {
    path: '/watch/:id/season/:s',
    component: Watch,
    getData: (ctx: RequestContext) => ({
      id: ctx.params.id,
      season: ctx.params.s,
      title: `Watch ${ctx.params.id} S${ctx.params.s}`,
    }),
  },
  {
    path: '/static',
    component: Static,
    // no getData → {} in __DATA__
  },
  {
    path: '/fail',
    component: Erroring,
    getData: () => { throw new Error('getData exploded') },
    onError: (err) => ({ error: err.message, recovered: true }),
  },
  {
    path: '/guarded/:id',
    component: Guarded,
    getData: (ctx: RequestContext) => ({ id: ctx.params.id }),
    validateParams: (params) => /^\d+$/.test(params.id),
  },
  {
    path: '/tracked',
    component: Home,
    getData: () => ({ tracked: true }),
    beforeRender: () => { beforeRenderCount++ },
  },
]

// ── App ───────────────────────────────────────────────────────────────

const app = createApp({
  routes,
  title: 'E2E Test',
  headContent: '<meta name="e2e" content="yes">',
  configLoader: async () => ({ theme: 'dark', version: 1 }),
})

// Expose beforeRenderCount for tests via a custom header
app.use('/__count', (c) => c.json({ beforeRenderCount }))

serve({ fetch: app.fetch, port: 3157 }, (s: any) => {
  console.log(`e2e server running on port ${s.port}`)
})