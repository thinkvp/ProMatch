/**
 * Scope maths, the way colourists compare two shots: a vectorscope (hue and
 * saturation as Rec.709 Cb/Cr) and the luma distribution. Pure and DOM-free;
 * panel/scopes-view.ts draws the results.
 *
 * Point-based error numbers only measure AT the points. Scopes show the
 * whole picture (or a chosen part of it), so a match that is right at every
 * point but wrong in between still shows up.
 */

export type PixelData = Uint8ClampedArray | Uint8Array

/** Rec.709 Y'CbCr of display-encoded 8-bit RGB: Y' 0..1, Cb/Cr −0.5..0.5. */
export function ycbcr(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  return [y, (B - y) / 1.8556, (R - y) / 1.5748]
}

/** Every `step`-th pixel offset (RGBA) of an image, optionally kept by a mask. */
export function pixelIndices(width: number, height: number, step: number, keep?: (x: number, y: number) => boolean): number[] {
  const out: number[] = []
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (!keep || keep(x, y)) out.push((y * width + x) * 4)
    }
  }
  return out
}

/** A step that keeps roughly `target` pixels of a w×h image. */
export function strideFor(width: number, height: number, target = 60000): number {
  return Math.max(1, Math.round(Math.sqrt((width * height) / target)))
}

export interface VectorDensity {
  size: number
  /** size×size counts, row-major, y down (Cr up on screen). */
  counts: Float32Array
  max: number
}

/**
 * Vectorscope density on a size×size grid. `zoom` 1 puts Cb/Cr ±0.5 at the
 * edge; skin and most interview colours sit well inside, so 2× is the
 * useful default.
 */
export function vectorscope(px: PixelData, idx: number[], size: number, zoom: number): VectorDensity {
  const counts = new Float32Array(size * size)
  const c = size / 2
  const k = (size / 2 - 2) * 2 * zoom // 0.5 chroma -> edge at zoom 1
  let max = 0
  for (const i of idx) {
    const [, cb, cr] = ycbcr(px[i], px[i + 1], px[i + 2])
    const x = Math.round(c + cb * k)
    const y = Math.round(c - cr * k)
    if (x < 0 || y < 0 || x >= size || y >= size) continue
    const v = ++counts[y * size + x]
    if (v > max) max = v
  }
  return { size, counts, max }
}

export interface LumaStats {
  /** 101 bins, Y' 0..100 (IRE-style), as fractions of the sampled pixels. */
  hist: Float32Array
  /** Y' at the 5th, 50th and 95th percentile, 0..100: shadows, mids, highlights. */
  p05: number
  p50: number
  p95: number
  /** Mean saturation (Cb/Cr radius, x100) and circular-mean hue in degrees. */
  saturation: number
  hue: number
  count: number
}

export function lumaStats(px: PixelData, idx: number[]): LumaStats {
  const hist = new Float32Array(101)
  let sat = 0
  let hx = 0
  let hy = 0
  for (const i of idx) {
    const [y, cb, cr] = ycbcr(px[i], px[i + 1], px[i + 2])
    hist[Math.min(100, Math.max(0, Math.round(y * 100)))]++
    const r = Math.hypot(cb, cr)
    sat += r
    // Hue weighted by saturation, so near-grey pixels do not dominate.
    hx += cb
    hy += cr
  }
  const n = Math.max(1, idx.length)
  let acc = 0
  const pct = (p: number) => {
    acc = 0
    for (let b = 0; b <= 100; b++) {
      acc += hist[b]
      if (acc >= p * n) return b
    }
    return 100
  }
  const p05 = pct(0.05)
  const p50 = pct(0.5)
  const p95 = pct(0.95)
  for (let b = 0; b <= 100; b++) hist[b] /= n
  const hue = ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360
  return { hist, p05, p50, p95, saturation: (sat / n) * 100, hue, count: idx.length }
}

/** Angle of the skin-tone ("flesh") line on a Cb/Cr vectorscope, degrees from +Cb. */
export const SKIN_LINE_DEG = 123

/** The 75% colour-bar targets, for the graticule. */
export function barTargets(): Array<{ name: string; cb: number; cr: number }> {
  const bars: Array<[string, number, number, number]> = [
    ['R', 0.75, 0, 0],
    ['Yl', 0.75, 0.75, 0],
    ['G', 0, 0.75, 0],
    ['Cy', 0, 0.75, 0.75],
    ['B', 0, 0, 0.75],
    ['Mg', 0.75, 0, 0.75],
  ]
  return bars.map(([name, r, g, b]) => {
    const [, cb, cr] = ycbcr(r * 255, g * 255, b * 255)
    return { name, cb, cr }
  })
}

/** Convex hull (monotone chain) of points, counter-clockwise. */
export function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Array<[number, number]> = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

export function insidePolygon(poly: Array<[number, number]>, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
