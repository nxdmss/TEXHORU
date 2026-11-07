import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demoDomain, waitReady } from '../scripts/demo-config.mjs'

test('Demo uses one explicit stable HTTPS host; rejects paths, ports and shell input', () => {
  assert.equal(demoDomain(' https://example.ngrok-free.dev/ '), 'example.ngrok-free.dev')
  for (const bad of ['', 'http://example.test', 'example.test/api', 'example.test:3000', 'example..test', 'example.test --foo', 'localhost'])
    assert.throws(() => demoDomain(bad))
})
test('Readiness waits for the expected project, rejecting a stale server and proxy errors', async () => {
  let calls = 0
  await waitReady('http://test/health', async response => (await response.json()).projectId === 'own', {
    attempts: 3, delay: 0, fetcher: async () => {
      calls++
      if (calls === 1) throw new Error('offline')
      return Response.json({ projectId: calls === 2 ? 'other' : 'own' })
    },
  })
  assert.equal(calls, 3)
  await assert.rejects(() => waitReady('http://test/health', async () => true, {
    attempts: 2, delay: 0, fetcher: async () => new Response('ngrok unavailable', { status: 404 }),
  }), /готовности/)
})
