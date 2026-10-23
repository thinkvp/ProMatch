/**
 * A downsampled analysis copy of a frame, in linear light and Oklab, for
 * whole-frame work (Auto). Box-downsampled to at most ~960 px wide, which
 * also denoises, and converted once.
 *
 * (Smart "magic wand" regions were tried here as an alternative to disc
 * picks and measured on real footage: no better than careful discs, and
 * worse for slightly-off picks, because lighting varies across a surface and
 * the two cameras see different parts of it. See spikes/SPIKES.md.)
 */
import { decode } from './color.ts'
import type { RgbaImage } from './sample.ts'

export interface Analysis {
  width: number
  height: number
  /** Full-resolution pixels per analysis pixel. */
  scale: number
  lin: Float32Array
  lab: Float32Array
}

const DECODE_8BIT = Array.from({ length: 256 }, (_, i) => decode(i / 255))

export function analyse(img: RgbaImage, maxWidth = 960): Analysis {
  const f = Math.max(1, Math.ceil(img.width / maxWidth))
  const width = Math.floor(img.width / f)
  const height = Math.floor(img.height / f)
  const lin = new Float32Array(width * height * 3)
  const lab = new Float32Array(width * height * 3)
  const d = img.data
  const n = f * f
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let dy = 0; dy < f; dy++) {
        let i = ((y * f + dy) * img.width + x * f) * 4
        for (let dx = 0; dx < f; dx++, i += 4) {
          r += DECODE_8BIT[d[i]]
          g += DECODE_8BIT[d[i + 1]]
          b += DECODE_8BIT[d[i + 2]]
        }
      }
      const o = (y * width + x) * 3
      r /= n
      g /= n
      b /= n
      lin[o] = r
      lin[o + 1] = g
      lin[o + 2] = b
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
      lab[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
      lab[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
      lab[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    }
  }
  return { width, height, scale: f, lin, lab }
}
