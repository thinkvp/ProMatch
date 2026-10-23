/**
 * 3D LUT baking and the .cube format (Adobe/Resolve flavour, which is what
 * Lumetri reads). Data order is red fastest, then green, then blue.
 */
import type { Vec3 } from './color.ts'

export interface Lut3D {
  size: number
  /** size³ × 3 floats, red fastest. */
  data: Float32Array
}

export function bakeLut(size: number, fn: (rgb: Vec3) => Vec3): Lut3D {
  const data = new Float32Array(size * size * size * 3)
  const step = 1 / (size - 1)
  let o = 0
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn([r * step, g * step, b * step])
        data[o++] = out[0]
        data[o++] = out[1]
        data[o++] = out[2]
      }
    }
  }
  return { size, data }
}

export function toCube(lut: Lut3D, title: string, comments: string[] = []): string {
  const lines: string[] = []
  for (const c of comments) lines.push(`# ${c}`)
  // Lumetri shows TITLE in its dropdown; keep it to plain characters.
  lines.push(`TITLE "${title.replace(/["\r\n]/g, '')}"`)
  lines.push(`LUT_3D_SIZE ${lut.size}`)
  lines.push('DOMAIN_MIN 0.0 0.0 0.0')
  lines.push('DOMAIN_MAX 1.0 1.0 1.0')
  const d = lut.data
  for (let i = 0; i < d.length; i += 3) {
    lines.push(`${d[i].toFixed(6)} ${d[i + 1].toFixed(6)} ${d[i + 2].toFixed(6)}`)
  }
  return lines.join('\n') + '\n'
}

export function parseCube(text: string): Lut3D {
  let size = 0
  const values: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10)
      continue
    }
    if (/^[A-Z_]/.test(line)) continue
    for (const v of line.split(/\s+/)) values.push(parseFloat(v))
  }
  if (!size || values.length !== size * size * size * 3) throw new Error('malformed .cube')
  return { size, data: Float32Array.from(values) }
}

/** Trilinear lookup. Used for the in-panel preview, so it matches the file. */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number, out: Vec3): Vec3 {
  const n = lut.size - 1
  const fr = Math.min(Math.max(r, 0), 1) * n
  const fg = Math.min(Math.max(g, 0), 1) * n
  const fb = Math.min(Math.max(b, 0), 1) * n
  const r0 = Math.min(Math.floor(fr), n - 1)
  const g0 = Math.min(Math.floor(fg), n - 1)
  const b0 = Math.min(Math.floor(fb), n - 1)
  const dr = fr - r0
  const dg = fg - g0
  const db = fb - b0
  const s = lut.size
  const d = lut.data
  const i000 = ((b0 * s + g0) * s + r0) * 3
  const i100 = i000 + 3
  const i010 = i000 + s * 3
  const i110 = i010 + 3
  const i001 = i000 + s * s * 3
  const i101 = i001 + 3
  const i011 = i001 + s * 3
  const i111 = i011 + 3
  for (let c = 0; c < 3; c++) {
    const c00 = d[i000 + c] + (d[i100 + c] - d[i000 + c]) * dr
    const c10 = d[i010 + c] + (d[i110 + c] - d[i010 + c]) * dr
    const c01 = d[i001 + c] + (d[i101 + c] - d[i001 + c]) * dr
    const c11 = d[i011 + c] + (d[i111 + c] - d[i011 + c]) * dr
    const c0 = c00 + (c10 - c00) * dg
    const c1 = c01 + (c11 - c01) * dg
    out[c] = c0 + (c1 - c0) * db
  }
  return out
}

/** Apply a LUT to 8-bit RGBA pixels in place (alpha untouched). */
export function applyLutToPixels(lut: Lut3D, px: Uint8ClampedArray | Uint8Array): void {
  const tmp: Vec3 = [0, 0, 0]
  const inv = 1 / 255
  for (let i = 0; i < px.length; i += 4) {
    sampleLut(lut, px[i] * inv, px[i + 1] * inv, px[i + 2] * inv, tmp)
    px[i] = Math.round(tmp[0] * 255)
    px[i + 1] = Math.round(tmp[1] * 255)
    px[i + 2] = Math.round(tmp[2] * 255)
  }
}
