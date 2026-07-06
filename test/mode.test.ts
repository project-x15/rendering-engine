import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectMode } from '../src/mode.js'

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost' + url, { headers })
}

test('detectMode: ?tv=1 forces CSR', () => {
  assert.equal(detectMode(req('/?tv=1')), 'csr')
})

test('detectMode: ?web=1 forces SSR', () => {
  assert.equal(detectMode(req('/?web=1')), 'ssr')
})

test('detectMode: tv-mode=1 cookie forces CSR', () => {
  assert.equal(detectMode(req('/', { cookie: 'tv-mode=1' })), 'csr')
})

test('detectMode: tv-mode=0 cookie forces SSR', () => {
  assert.equal(detectMode(req('/', { cookie: 'tv-mode=0; other=val' })), 'ssr')
})

test('detectMode: Sec-CH-UA-Platform "TV" → CSR', () => {
  assert.equal(detectMode(req('/', { 'sec-ch-ua-platform': '"Television"' })), 'csr')
})

test('detectMode: Tizen UA → CSR', () => {
  assert.equal(detectMode(req('/', { 'user-agent': 'Mozilla/5.0 (SMART-TV; Tizen 2.4)' })), 'csr')
})

test('detectMode: WebOS UA → CSR', () => {
  assert.equal(detectMode(req('/', { 'user-agent': 'Mozilla/5.0 (Web0S; Linux/SmartTV)' })), 'csr')
})

test('detectMode: Roku UA → CSR', () => {
  assert.equal(detectMode(req('/', { 'user-agent': 'Roku/DVP-9.0' })), 'csr')
})

test('detectMode: normal browser UA → SSR (default)', () => {
  assert.equal(detectMode(req('/', { 'user-agent': 'Mozilla/5.0 Chrome/120.0' })), 'ssr')
})

test('detectMode: no headers → SSR (default)', () => {
  assert.equal(detectMode(req('/')), 'ssr')
})

test('detectMode: ?tv=1 takes priority over cookie tv-mode=0', () => {
  assert.equal(detectMode(req('/?tv=1', { cookie: 'tv-mode=0' })), 'csr')
})