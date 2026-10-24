/**
 * Scope maths, the way colourists compare two shots: a hue x saturation map
 * (an unwrapped vectorscope, in Oklab so equal steps look equal), the luma
 * distribution and an RGB parade. Pure and DOM-free; panel/scopes-view.ts
 * draws the results.
 *
 * Point-based error numbers only measure AT the points. Scopes show the
 * whole picture (or a chosen part of it), so a match that is right at every
 * point but wrong in between still shows up.
 */

import { decode, linearToOklab } from './color.ts'

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

/** A 2-D histogram, row-major, y down. */
export interface Density {
  width: number
  height: number
  counts: Float32Array
  max: number
}

/**
 * Where the hue axis starts, in Oklab degrees. Magenta sits at the seam, so
 * reds, skin and oranges stay together left of centre instead of splitting
 * across the edges.
 */
export const HUE_START = 330

/** Oklab hue of typical skin (light to dark tones all sit within a few degrees). */
export const SKIN_HUE_DEG = 50

/** Hue in Oklab degrees -> 0..1 across the hue map. */
export function hueToX(hue: number): number {
  return ((((hue - HUE_START) % 360) + 360) % 360) / 360
}

export function xToHue(x: number): number {
  return (HUE_START + x * 360) % 360
}

/**
 * Hue (across) x saturation (up) density on a width x height grid. `satMax`
 * (Oklab chroma x100) is the top edge; anything more colourful sits on it.
 * Near-greys and near-blacks have no meaningful hue (in the dark, one code
 * value swings it wildly) and are left out.
 */
const MAP_MIN_LUMA = 6

export function hueMap(planes: QualifierPlanes, idx: number[], width: number, height: number, satMax: number): Density {
  const counts = new Float32Array(width * height)
  let max = 0
  for (const i of idx) {
    const p = i >> 2
    const sat = planes.sat[p]
    if (sat < HUELESS_SAT || planes.y[p] < MAP_MIN_LUMA) continue
    const x = Math.min(width - 1, Math.floor(hueToX(planes.hue[p]) * width))
    const y = Math.max(0, Math.round((height - 1) * (1 - Math.min(1, sat / satMax))))
    const v = ++counts[y * width + x]
    if (v > max) max = v
  }
  return { width, height, counts, max }
}

/**
 * RGB parade: for each channel, image column (across, `cols` bins) by level
 * (up, `rows` bins, 0 at the bottom). Position across is the frame's own
 * left-to-right, so two cameras' parades compare by shape, not column.
 */
export function parade(px: PixelData, imgWidth: number, idx: number[], cols: number, rows: number): [Density, Density, Density] {
  const out = [0, 1, 2].map(() => ({ width: cols, height: rows, counts: new Float32Array(cols * rows), max: 0 })) as [Density, Density, Density]
  const kx = cols / imgWidth
  const ky = (rows - 1) / 255
  for (const i of idx) {
    const x = Math.min(cols - 1, Math.floor(((i >> 2) % imgWidth) * kx))
    for (let c = 0; c < 3; c++) {
      const d = out[c]
      const v = ++d.counts[(rows - 1 - Math.round(px[i + c] * ky)) * cols + x]
      if (v > d.max) d.max = v
    }
  }
  return out
}

export interface LumaStats {
  /** 101 bins, Y' 0..100 (IRE-style), as fractions of the sampled pixels. */
  hist: Float32Array
  /** Y' at the 5th, 50th and 95th percentile, 0..100: shadows, mids, highlights. */
  p05: number
  p50: number
  p95: number
  /** Mean saturation (Oklab chroma x100) and chroma-weighted mean hue in Oklab degrees. */
  saturation: number
  hue: number
  count: number
}

export function lumaStats(planes: QualifierPlanes, idx: number[]): LumaStats {
  const hist = new Float32Array(101)
  let sat = 0
  let hx = 0
  let hy = 0
  for (const i of idx) {
    const p = i >> 2
    hist[planes.y[p]]++
    const c = planes.sat[p]
    sat += c
    // Hue weighted by saturation, so near-grey pixels do not dominate.
    const h = (planes.hue[p] * Math.PI) / 180
    hx += c * Math.cos(h)
    hy += c * Math.sin(h)
  }
  const n = Math.max(1, idx.length)
  let acc = 0
  const pct = (q: number) => {
    acc = 0
    for (let b = 0; b <= 100; b++) {
      acc += hist[b]
      if (acc >= q * n) return b
    }
    return 100
  }
  const p05 = pct(0.05)
  const p50 = pct(0.5)
  const p95 = pct(0.95)
  for (let b = 0; b <= 100; b++) hist[b] /= n
  const hue = ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360
  return { hist, p05, p50, p95, saturation: sat / n, hue, count: idx.length }
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

/**
 * A range picked on the scopes, Lumetri "Color/Gray" style: pixels inside
 * keep their colour, the rest turn grey. Luma comes from the luma scope or
 * parade; hue and saturation from a box on the hue map. Units match the
 * scopes: luma Y' 0–100, hue in Oklab degrees (arc from `hue[0]` round to
 * `hue[1]`), saturation = Oklab chroma ×100.
 */
export interface Qualifier {
  luma?: [number, number]
  hue?: [number, number]
  sat?: [number, number]
}

/** Per-pixel luma / hue / saturation of an image, so re-qualifying while dragging is cheap. */
export interface QualifierPlanes {
  width: number
  height: number
  /** Rec.709 Y' x100, as on the luma scope. */
  y: Uint8Array
  /** Oklab hue, degrees. */
  hue: Float32Array
  /** Oklab chroma x100. */
  sat: Float32Array
}

export function qualifierPlanes(img: { width: number; height: number; data: PixelData }): QualifierPlanes {
  const n = img.width * img.height
  const y = new Uint8Array(n)
  const hue = new Float32Array(n)
  const sat = new Float32Array(n)
  const d = img.data
  const lin = new Float64Array(256)
  for (let v = 0; v < 256; v++) lin[v] = decode(v / 255)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    y[i] = Math.round(ycbcr(d[o], d[o + 1], d[o + 2])[0] * 100)
    const [, a, b] = linearToOklab([lin[d[o]], lin[d[o + 1]], lin[d[o + 2]]])
    sat[i] = Math.hypot(a, b) * 100
    hue[i] = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
  }
  return { width: img.width, height: img.height, y, hue, sat }
}

/** Below this saturation a pixel has no meaningful hue, so a hue range never includes it. */
const HUELESS_SAT = 0.5

export function inQualifier(q: Qualifier, y: number, hue: number, sat: number): boolean {
  if (q.luma && (y < q.luma[0] || y > q.luma[1])) return false
  if (q.sat && (sat < q.sat[0] || sat > q.sat[1])) return false
  if (q.hue) {
    if (sat < HUELESS_SAT) return false
    const span = (q.hue[1] - q.hue[0] + 360) % 360
    if ((hue - q.hue[0] + 360) % 360 > span) return false
  }
  return true
}

export function isActive(q: Qualifier | null): q is Qualifier {
  return !!q && !!(q.luma || q.hue || q.sat)
}

/**
 * Write the Color/Gray view of `src` into `out` (RGBA, same size): inside the
 * range unchanged, outside replaced by its own luma as grey. Returns the
 * share of pixels inside (0–1).
 */
export function isolate(src: PixelData, planes: QualifierPlanes, q: Qualifier, out: Uint8ClampedArray): number {
  let inside = 0
  const n = planes.width * planes.height
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (inQualifier(q, planes.y[i], planes.hue[i], planes.sat[i])) {
      out[o] = src[o]
      out[o + 1] = src[o + 1]
      out[o + 2] = src[o + 2]
      inside++
    } else {
      const g = Math.round(planes.y[i] * 2.55)
      out[o] = g
      out[o + 1] = g
      out[o + 2] = g
    }
    out[o + 3] = 255
  }
  return inside / Math.max(1, n)
}

/** Short human description, e.g. "Luma 40–60 · Hue 100–140° · Sat 5–20". */
export function describeQualifier(q: Qualifier): string {
  const parts: string[] = []
  if (q.luma) parts.push(`Luma ${Math.round(q.luma[0])}–${Math.round(q.luma[1])}`)
  if (q.hue) parts.push(`Hue ${Math.round(q.hue[0])}–${Math.round(q.hue[1])}°`)
  if (q.sat) parts.push(`Sat ${Math.round(q.sat[0])}–${Math.round(q.sat[1])}`)
  return parts.join(' · ')
}
