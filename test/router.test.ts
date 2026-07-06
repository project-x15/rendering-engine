import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchRoute } from '../src/router.js'
import type { Route } from '../src/types.js'

const routes: Route[] = [
  { path: '/', component: () => null },
  { path: '/browse', component: () => null },
  { path: '/details/:id', component: () => null },
]

test('matchRoute: exact root match', () => {
  const m = matchRoute(routes, '/')
  assert.ok(m)
  assert.deepEqual(m!.params, {})
})

test('matchRoute: static path match', () => {
  const m = matchRoute(routes, '/browse')
  assert.ok(m)
  assert.equal(m!.route.path, '/browse')
})

test('matchRoute: param extraction', () => {
  const m = matchRoute(routes, '/details/1396')
  assert.ok(m)
  assert.equal(m!.route.path, '/details/:id')
  assert.equal(m!.params.id, '1396')
})

test('matchRoute: unknown path returns null', () => {
  assert.equal(matchRoute(routes, '/unknown'), null)
})

test('matchRoute: trailing slash normalized', () => {
  const m = matchRoute(routes, '/browse/')
  assert.ok(m)
  assert.equal(m!.route.path, '/browse')
})

test('matchRoute: first match wins', () => {
  const dup: Route[] = [
    { path: '/details/:id', component: () => null },
    { path: '/details/:id', component: () => null },
  ]
  const m = matchRoute(dup, '/details/1')
  assert.equal(m!.route, dup[0])
})

test('matchRoute: empty routes returns null', () => {
  assert.equal(matchRoute([], '/'), null)
})

test('matchRoute: root with trailing slash still matches root', () => {
  const m = matchRoute(routes, '/')
  assert.ok(m)
})
test('matchRoute: malformed percent-encoding (%zz) returns null (catch branch)', () => {
  // decodeURIComponent('%zz') throws — matchPath must treat as no-match, not crash
  assert.equal(matchRoute(routes, '/details/%zz'), null)
})

test('matchRoute: valid percent-encoding decodes params', () => {
  const m = matchRoute(routes, '/details/hello%20world')
  assert.ok(m)
  assert.equal(m!.params.id, 'hello world')
})
