import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { productImage } from './store-utils'

type Bounds = { x: number; y: number; width: number; height: number; naturalWidth: number; naturalHeight: number }
const boundsCache = new Map<string, Bounds>()

// Read transparent margins once per URL. Originals stay untouched, including transparency.
function imageBounds(image: HTMLImageElement): Bounds {
  const key = image.currentSrc || image.src
  const cached = boundsCache.get(key)
  if (cached) return cached
  const naturalWidth = image.naturalWidth, naturalHeight = image.naturalHeight
  let result: Bounds = { x: 0, y: 0, width: naturalWidth, height: naturalHeight, naturalWidth, naturalHeight }
  try {
    const sample = Math.min(1, 384 / Math.max(naturalWidth, naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(naturalWidth * sample))
    canvas.height = Math.max(1, Math.round(naturalHeight * sample))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let left = canvas.width, right = -1, top = canvas.height, bottom = -1
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] < 24) continue
        left = Math.min(left, x); right = Math.max(right, x)
        top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
      if (right >= left && bottom >= top) {
        const sx = naturalWidth / canvas.width, sy = naturalHeight / canvas.height
        result = { x: left * sx, y: top * sy, width: (right - left + 1) * sx,
          height: (bottom - top + 1) * sy, naturalWidth, naturalHeight }
      }
    }
  } catch { /* External images without CORS use their original frame and still fit safely. */ }
  if (boundsCache.size >= 160) boundsCache.delete(boundsCache.keys().next().value!)
  boundsCache.set(key, result)
  return result
}

// Body height in mm, independent of storage, colour, SIM and photo resolution.
function relativeSize(name: string) {
  if (/чехол|накладка|стекло|кабель|пленк|плёнк|защитн|линз/i.test(name)) return 1
  const model = name.match(/\biphone\s*(1[2-7])\s*(pro\s*max|pro|plus|mini|air|e)?\b/i)
  const heights: Record<string, number[]> = {
    '': [146.7, 146.7, 146.7, 147.6, 147.6, 149.6],
    pro: [146.7, 146.7, 147.5, 146.6, 149.6, 150],
    promax: [160.8, 160.8, 160.7, 159.9, 163, 163.4],
    plus: [0, 0, 160.8, 160.9, 160.9, 0],
    mini: [131.5, 131.5, 0, 0, 0, 0],
    e: [0, 0, 0, 0, 146.7, 0],
    air: [0, 0, 0, 0, 0, 156.2],
  }
  const height = model && heights[(model[2] || '').toLowerCase().replace(/\s/g, '')]?.[Number(model[1]) - 12]
  return height ? height / 163.4 : 1
}

/** Shared, non-distorting product frame for catalog, detail, basket and editor. */
export function ProductImage({ name, image, alt = name, loading = 'lazy' }: {
  name: string; image?: string; alt?: string; loading?: 'lazy' | 'eager'
}) {
  const original = productImage({ name, image: image || '/products/phone.svg' })
  const [failed, setFailed] = useState('')
  const src = failed === original ? '/products/phone.svg' : original
  const [loaded, setLoaded] = useState<{ src: string; bounds: Bounds } | null>(null)
  const frame = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const bounds = loaded?.src === src ? loaded.bounds : null
  let style: CSSProperties = {}
  if (bounds && size.width && size.height && bounds.width && bounds.height) {
    const scale = Math.min(size.width / bounds.width, size.height / bounds.height) * .98 * relativeSize(name)
    style = {
      '--shot-width': bounds.naturalWidth * scale + 'px', '--shot-height': bounds.naturalHeight * scale + 'px',
      '--shot-left': (size.width - bounds.width * scale) / 2 - bounds.x * scale + 'px',
      '--shot-top': (size.height - bounds.height * scale) / 2 - bounds.y * scale + 'px',
    } as CSSProperties
  }
  return <span className="product-shot" ref={frame} style={style} data-normalized={Boolean(bounds)}>
    <img src={src} alt={alt} loading={loading} decoding="async"
      onLoad={e => setLoaded({ src, bounds: imageBounds(e.currentTarget) })}
      onError={() => { if (src !== '/products/phone.svg') setFailed(original) }} />
  </span>
}
