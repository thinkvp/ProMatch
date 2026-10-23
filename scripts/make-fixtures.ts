/**
 * Write two test frames to fixtures/: the same synthetic room seen by
 * "camera A" (wide) and "camera B" (tighter framing, darker, warmer, with a
 * red-hue twist). Load them with Open… to try the panel without Premiere.
 * Run: npm run fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import type { Vec3 } from '../src/core/color.ts'
import { cameraB } from './synthetic.ts'

const W = 1920
const H = 1080

let seed = 7
function noise(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296 - 0.5
}

function inEllipse(u: number, v: number, cu: number, cv: number, ru: number, rv: number): number {
  return ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2
}

/** The room as camera A renders it, in world coordinates 0..1. */
function scene(u: number, v: number): Vec3 {
  // Table edge along the bottom.
  if (v > 0.82) return [0.16, 0.12, 0.1]
  // Apple: shaded red sphere with a highlight.
  const a = inEllipse(u, v, 0.28, 0.7, 0.06, 0.06 * (16 / 9))
  if (a < 1) {
    const shade = 1 - 0.45 * Math.max(0, (u - 0.28) / 0.06 + (v - 0.7) / 0.107) / 2
    if (inEllipse(u, v, 0.265, 0.67, 0.008, 0.014) < 1) return [0.97, 0.9, 0.88]
    return [0.78 * shade, 0.13 * shade, 0.1 * shade]
  }
  // Interviewee: face, then a blue shirt.
  if (inEllipse(u, v, 0.6, 0.36, 0.07, 0.17) < 1) return [0.82, 0.6, 0.5]
  if (v > 0.52 && Math.abs(u - 0.6) < 0.14 - (0.82 - v) * 0.1) return [0.18, 0.3, 0.55]
  // Yellow book on a shelf, green plant.
  if (u > 0.08 && u < 0.2 && v > 0.18 && v < 0.33) return [0.85, 0.72, 0.18]
  if (inEllipse(u, v, 0.86, 0.6, 0.07, 0.16) < 1) return [0.25, 0.48, 0.2]
  // Warm grey wall, a bit darker toward the bottom.
  const g = 0.62 - 0.12 * v
  return [g, g * 0.97, g * 0.92]
}

function render(cam: (c: Vec3) => Vec3, u0: number, v0: number, span: number): Uint8Array {
  const px = new Uint8Array(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = cam(scene(u0 + (x / W) * span, v0 + (y / H) * span))
      const i = (y * W + x) * 3
      for (let k = 0; k < 3; k++) px[i + k] = Math.max(0, Math.min(255, Math.round(c[k] * 255 + noise() * 4)))
    }
  }
  return px
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buf: Uint8Array): number {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function png(rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) Buffer.from(rgb.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ])
}

mkdirSync('fixtures', { recursive: true })
writeFileSync('fixtures/camA-source.png', png(render((c) => c, 0, 0, 1)))
writeFileSync('fixtures/camB-target.png', png(render((c) => cameraB(c), 0.1, 0.06, 0.82)))
console.log('wrote fixtures/camA-source.png and fixtures/camB-target.png')
