export function demoDomain(value) {
  const raw = String(value || '').trim().replace(/^https:\/\//i, '').replace(/\/$/, '').toLowerCase()
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(raw)
      || !raw.includes('.') || raw.includes('..')) throw new Error('Укажи HTTPS-домен ngrok без пути и порта.')
  return raw
}
export async function waitReady(url, validate, { attempts = 90, delay = 1000, fetcher = fetch, stopped = () => false } = {}) {
  for (let n = 0; n < attempts && !stopped(); n++) {
    try {
      const response = await fetcher(url, { headers: { 'ngrok-skip-browser-warning': 'true' }, signal: AbortSignal.timeout(3000) })
      if (response.ok && await validate(response)) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  throw new Error(`Не удалось дождаться готовности: ${url}`)
}
