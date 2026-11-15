import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const oneCBodyHash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex')

export function oneCSignatureMessage(method: string, path: string, timestamp: string, nonce: string, bodyHash: string) {
  return [method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n')
}

export function signOneCRequest(secret: string, method: string, path: string, timestamp: string, nonce: string, body: Buffer | string) {
  return createHmac('sha256', secret).update(oneCSignatureMessage(method, path, timestamp, nonce, oneCBodyHash(body))).digest('hex')
}

export function safeHexEqual(actual: string, expected: string) {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false
  return timingSafeEqual(Buffer.from(actual.toLowerCase(), 'hex'), Buffer.from(expected.toLowerCase(), 'hex'))
}
