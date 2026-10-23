/**
 * Colour-space plumbing. Everything in core/ is pure and DOM-free so it runs
 * under tsx in scripts/test.ts exactly as it runs in the panel.
 *
 * Three spaces are in play:
 *   - ENCODED: display-referred Rec.709 values 0..1, i.e. what Premiere hands
 *     a LUT and what an exported PNG frame contains.
 *   - LINEAR: light. Exposure is a multiply here and camera differences are
 *     close to a 3x3 matrix here, so the global fit happens in this space.
 *   - OKLAB: perceptual. "Make this red look like that red" is a distance
 *     question, so the local per-colour correction lives here.
 */

export type Vec3 = [number, number, number]

/** BT.1886 display gamma. A pure power is the honest inverse of what a
 *  Rec.709 monitor does to these values. */
export const DISPLAY_GAMMA = 2.4

export function decode(v: number): number {
  return v <= 0 ? 0 : Math.pow(v, DISPLAY_GAMMA)
}

export function encode(v: number): number {
  return v <= 0 ? 0 : Math.pow(v, 1 / DISPLAY_GAMMA)
}

export function decodeRgb(c: Vec3): Vec3 {
  return [decode(c[0]), decode(c[1]), decode(c[2])]
}

export function encodeRgb(c: Vec3): Vec3 {
  return [encode(c[0]), encode(c[1]), encode(c[2])]
}

/** Rec.709 luminance of a LINEAR colour. */
export function luminance(c: Vec3): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/** Linear Rec.709/sRGB primaries -> Oklab (Björn Ottosson, 2020). */
export function linearToOklab(c: Vec3): Vec3 {
  const l = 0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]
  const m = 0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]
  const s = 0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ]
}

export function oklabToLinear(c: Vec3): Vec3 {
  const l_ = c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2]
  const m_ = c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2]
  const s_ = c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2]
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

export function encodedToOklab(c: Vec3): Vec3 {
  return linearToOklab(decodeRgb(c))
}

/** Oklab distance x100. Roughly: < 2 is hard to see side by side, > 10 is
 *  obviously a different colour. */
export function deltaE(a: Vec3, b: Vec3): number {
  const dl = a[0] - b[0]
  const da = a[1] - b[1]
  const db = a[2] - b[2]
  return 100 * Math.sqrt(dl * dl + da * da + db * db)
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

export function toHex(c: Vec3): string {
  let s = '#'
  for (let i = 0; i < 3; i++) {
    const v = Math.round(clamp01(c[i]) * 255)
    s += (v < 16 ? '0' : '') + v.toString(16)
  }
  return s
}
