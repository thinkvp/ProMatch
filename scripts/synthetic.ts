/**
 * A synthetic "camera B": camera A's picture with known, controllable errors.
 * Shared by the tests and the fixture generator.
 */
import { type Vec3, decodeRgb, encodeRgb, linearToOklab, luminance, oklabToLinear } from '../src/core/color.ts'

/**
 * Camera B = camera A with: darker, warmer, some channel crosstalk, reds
 * pushed toward orange + desaturated, and optionally a flatter profile
 * (contrast < 1 lifts the darks relative to the brights).
 */
export function cameraB(
  encA: Vec3,
  opts: { exposure?: number; wb?: Vec3; cross?: number; redShift?: number; contrast?: number } = {},
): Vec3 {
  const { exposure = -0.7, wb = [1.1, 1, 0.85], cross = 0.06, redShift = 0.35, contrast = 1 } = opts
  let lin = decodeRgb(encA)
  if (contrast !== 1) {
    const f = Math.pow(Math.max(luminance(lin), 1e-6), contrast - 1)
    lin = [lin[0] * f, lin[1] * f, lin[2] * f]
  }
  const k = Math.pow(2, exposure)
  const m = [1 - 2 * cross, cross, cross, cross, 1 - 2 * cross, cross, cross, cross, 1 - 2 * cross]
  lin = [
    k * wb[0] * (m[0] * lin[0] + m[1] * lin[1] + m[2] * lin[2]),
    k * wb[1] * (m[3] * lin[0] + m[4] * lin[1] + m[5] * lin[2]),
    k * wb[2] * (m[6] * lin[0] + m[7] * lin[1] + m[8] * lin[2]),
  ]
  if (redShift) {
    const [L, a, b] = linearToOklab(lin)
    const h = Math.atan2(b, a)
    const C = Math.hypot(a, b)
    // Hue ~0.5 rad is red in Oklab. Bend only that neighbourhood.
    const near = Math.exp(-(((h - 0.5) / 0.45) ** 2))
    const h2 = h + redShift * near
    const C2 = C * (1 - 0.25 * near)
    lin = oklabToLinear([L, C2 * Math.cos(h2), C2 * Math.sin(h2)])
    lin = [Math.max(0, lin[0]), Math.max(0, lin[1]), Math.max(0, lin[2])]
  }
  return encodeRgb(lin)
}
