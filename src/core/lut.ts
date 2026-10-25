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

/** Trilinear lookup. */
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

/**
 * Tetrahedral lookup: what the native ProMatch effect uses
 * (native/src/lut_engine.cpp, same case split). Exact on the grid like
 * trilinear, but each result mixes 4 corners instead of 8.
 */
export function sampleLutTetra(lut: Lut3D, r: number, g: number, b: number, out: Vec3): Vec3 {
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
  const sr = 3
  const sg = lut.size * 3
  const sb = lut.size * lut.size * 3
  const o = b0 * sb + g0 * sg + r0 * sr
  let a: number, c: number, w0: number, w1: number, w2: number, w3: number
  if (dr > dg) {
    if (dg > db) [a, c, w0, w1, w2, w3] = [sr, sr + sg, 1 - dr, dr - dg, dg - db, db]
    else if (dr > db) [a, c, w0, w1, w2, w3] = [sr, sr + sb, 1 - dr, dr - db, db - dg, dg]
    else [a, c, w0, w1, w2, w3] = [sb, sr + sb, 1 - db, db - dr, dr - dg, dg]
  } else if (db > dg) [a, c, w0, w1, w2, w3] = [sb, sg + sb, 1 - db, db - dg, dg - dr, dr]
  else if (db > dr) [a, c, w0, w1, w2, w3] = [sg, sg + sb, 1 - dg, dg - db, db - dr, dr]
  else [a, c, w0, w1, w2, w3] = [sg, sr + sg, 1 - dg, dg - dr, dr - db, db]
  const d = lut.data
  const e = o + sr + sg + sb
  for (let k = 0; k < 3; k++) out[k] = w0 * d[o + k] + w1 * d[o + a + k] + w2 * d[o + c + k] + w3 * d[e + k]
  return out
}

/**
 * Apply a LUT to 8-bit RGBA pixels in place (alpha untouched). Tetrahedral,
 * like the native effect, so the panel's After view is what Apply renders.
 */
export function applyLutToPixels(lut: Lut3D, px: Uint8ClampedArray | Uint8Array): void {
  const tmp: Vec3 = [0, 0, 0]
  const inv = 1 / 255
  for (let i = 0; i < px.length; i += 4) {
    sampleLutTetra(lut, px[i] * inv, px[i + 1] * inv, px[i + 2] * inv, tmp)
    px[i] = Math.round(tmp[0] * 255)
    px[i + 1] = Math.round(tmp[1] * 255)
    px[i + 2] = Math.round(tmp[2] * 255)
  }
}

/**
 * The LUT as text for the ProMatch effect's embedded "LUT" parameter:
 * "PMLUT3 <id> <name> <size> <lo> <hi> <base64>", the data being size³ × 3
 * little-endian uint16 values mapped linearly onto [lo, hi] (red fastest),
 * id the match ID, which is how Apply finds every clip using this match, and
 * name what Effect Controls shows (percent-encoded, "-" for none). About a
 * third of the .cube's size, and exact to 1/65535 of the range. The effect
 * parses it in native/src/lut_engine.cpp (parseEmbeddedText).
 */
export function toEmbeddedText(lut: Lut3D, id: number, name = ''): string {
  let lo = Infinity
  let hi = -Infinity
  for (const v of lut.data) {
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  if (!(hi > lo)) hi = lo + 1
  // Round to float32 first: the effect stores lo/hi as float.
  lo = Math.fround(lo)
  hi = Math.fround(hi)
  const bytes = new Uint8Array(lut.data.length * 2)
  const scale = 65535 / (hi - lo)
  for (let i = 0; i < lut.data.length; i++) {
    const q = Math.min(65535, Math.max(0, Math.round((lut.data[i] - lo) * scale)))
    bytes[2 * i] = q & 255
    bytes[2 * i + 1] = q >> 8
  }
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `PMLUT3 ${Math.round(id)} ${encodeName(name)} ${lut.size} ${lo.toPrecision(9)} ${hi.toPrecision(9)} ${btoa(bin)}`
}

/** Percent-encoded UTF-8 with nothing but [A-Za-z0-9._~-], as the effect decodes it. */
function encodeName(name: string): string {
  if (!name) return '-'
  return encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** The match ID in an effect's LUT text, or null (none, a pattern, a build-6 "PMLUT1", or 0: picked in Effect Controls). */
export function embeddedId(text: string): number | null {
  const m = /^PMLUT[23] (\d+) /.exec(text)
  return m && m[1] !== '0' ? parseInt(m[1], 10) : null
}

/** The LUT's name in an effect's LUT text ("" if none). */
export function embeddedName(text: string): string {
  const m = /^PMLUT3 \d+ (\S+) /.exec(text)
  return m && m[1] !== '-' ? decodeURIComponent(m[1]) : ''
}

/** Inverse of toEmbeddedText (also reads build-6 "PMLUT1"); null for "PMLUT0" (no LUT). */
export function parseEmbeddedText(text: string): Lut3D | null {
  if (text.startsWith('PMLUT0')) return null
  const m =
    /^PMLUT3 \d+ \S+ (\d+) (\S+) (\S+) (\S+)/.exec(text) ?? /^PMLUT2 \d+ (\d+) (\S+) (\S+) (\S+)/.exec(text) ?? /^PMLUT1 (\d+) (\S+) (\S+) (\S+)/.exec(text)
  if (!m) throw new Error('not a ProMatch LUT')
  const size = parseInt(m[1], 10)
  const lo = Math.fround(parseFloat(m[2]))
  const hi = Math.fround(parseFloat(m[3]))
  const bin = atob(m[4])
  const data = new Float32Array(size * size * size * 3)
  if (bin.length !== data.length * 2) throw new Error('LUT data is truncated')
  const scale = (hi - lo) / 65535
  for (let i = 0; i < data.length; i++) data[i] = lo + (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) * scale
  return { size, data }
}
