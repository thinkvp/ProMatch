/**
 * Read a colour out of a frame at a clicked point.
 *
 * A single pixel is useless (noise, compression blocks, debayer), so each
 * point is a disc. The disc is averaged in LINEAR light — that is what the
 * sensor saw — after trimming the brightest and darkest 10% by luma, which
 * throws away a specular glint on the apple or a dark seam at its edge.
 */
import { type Vec3, decode, encode } from './color.ts'
import type { Sample } from './match.ts'

export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

const TRIM = 0.1
const CLIP_LEVEL = 250

const DECODE_8BIT = Array.from({ length: 256 }, (_, i) => decode(i / 255))

export function sampleDisc(img: RgbaImage, cx: number, cy: number, radius: number): Sample {
  const r = Math.max(0.5, radius)
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(img.width - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(img.height - 1, Math.ceil(cy + r))
  const r2 = r * r
  const idx: number[] = []
  const luma: number[] = []
  let clippedPx = 0
  const d = img.data
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      if (dx * dx + dy * dy > r2) continue
      const i = (y * img.width + x) * 4
      idx.push(i)
      luma.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])
      if (d[i] >= CLIP_LEVEL || d[i + 1] >= CLIP_LEVEL || d[i + 2] >= CLIP_LEVEL) clippedPx++
    }
  }
  if (idx.length === 0) {
    // Click landed outside the frame; nearest pixel.
    const x = Math.min(img.width - 1, Math.max(0, Math.round(cx)))
    const y = Math.min(img.height - 1, Math.max(0, Math.round(cy)))
    const i = (y * img.width + x) * 4
    idx.push(i)
    luma.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])
  }

  const order = idx.map((_, k) => k).sort((a, b) => luma[a] - luma[b])
  const cut = idx.length >= 10 ? Math.floor(idx.length * TRIM) : 0
  const kept = order.slice(cut, order.length - cut)
  const acc: Vec3 = [0, 0, 0]
  let lsum = 0
  let lsq = 0
  for (const k of kept) {
    const i = idx[k]
    acc[0] += DECODE_8BIT[d[i]]
    acc[1] += DECODE_8BIT[d[i + 1]]
    acc[2] += DECODE_8BIT[d[i + 2]]
    const l = luma[k] / 255
    lsum += l
    lsq += l * l
  }
  const n = kept.length
  const mean = lsum / n
  const rgb: Vec3 = [encode(acc[0] / n), encode(acc[1] / n), encode(acc[2] / n)]
  return {
    rgb,
    spread: Math.sqrt(Math.max(0, lsq / n - mean * mean)),
    clipped: clippedPx / idx.length > 0.2 || Math.max(rgb[0], rgb[1], rgb[2]) > 0.985,
  }
}
