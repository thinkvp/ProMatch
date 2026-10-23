/**
 * SPIKE: can classic feature matching find the SAME physical points in the
 * two camera angles (so Auto pairs make sense), without AI?
 *
 * AKAZE keypoints on contrast-equalised greyscale (the cameras' colour
 * difference barely matters to gradient descriptors), ratio-test matching,
 * then homographies fitted one after another with RANSAC: each one is a
 * roughly planar part of the scene (wall + picture, sofa, the person), and
 * maps any point in the source to the same spot in the target.
 *
 * Run: npx tsx spikes/feature-match.ts   (writes captures/feature-match.png)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { encodePng, readPng } from '../scripts/png.ts'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cv: any = require('@techstark/opencv-js')
if (cv instanceof Promise) cv = await cv
else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r))

const dir = join(process.env.APPDATA!, 'ProMatch')
const s = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))
const src = readPng(s.frames.source.path)
const tgt = readPng(s.frames.target.path)
const WORK = 1280

function grey(img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }) {
  const rgba = cv.matFromImageData({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) })
  const g = new cv.Mat()
  cv.cvtColor(rgba, g, cv.COLOR_RGBA2GRAY)
  const k = WORK / img.width
  const small = new cv.Mat()
  cv.resize(g, small, new cv.Size(WORK, Math.round(img.height * k)), 0, 0, cv.INTER_AREA)
  const eq = new cv.Mat()
  const clahe = new cv.CLAHE(2.5, new cv.Size(8, 8))
  clahe.apply(small, eq)
  rgba.delete(), g.delete(), small.delete(), clahe.delete()
  return { mat: eq, k }
}

const t0 = Date.now()
const A = grey(src)
const B = grey(tgt)
const akaze = new cv.AKAZE()
akaze.setThreshold(0.0005)
const kpA = new cv.KeyPointVector()
const kpB = new cv.KeyPointVector()
const dA = new cv.Mat()
const dB = new cv.Mat()
const none = new cv.Mat()
akaze.detectAndCompute(A.mat, none, kpA, dA)
akaze.detectAndCompute(B.mat, none, kpB, dB)
const bf = new cv.BFMatcher(cv.NORM_HAMMING, false)
const knn = new cv.DMatchVectorVector()
bf.knnMatch(dA, dB, knn, 2)
const matches: Array<{ a: [number, number]; b: [number, number] }> = []
for (let i = 0; i < knn.size(); i++) {
  const m = knn.get(i)
  if (m.size() < 2) continue
  const m0 = m.get(0)
  const m1 = m.get(1)
  if (m0.distance < 0.8 * m1.distance) {
    const pa = kpA.get(m0.queryIdx).pt
    const pb = kpB.get(m0.trainIdx).pt
    matches.push({ a: [pa.x, pa.y], b: [pb.x, pb.y] })
  }
}
console.log(`keypoints ${kpA.size()} / ${kpB.size()}, ratio-test matches ${matches.length}, ${Date.now() - t0} ms`)

// Sequential RANSAC homographies: peel off one consistent plane at a time.
const groups: Array<{ H: number[]; pts: typeof matches }> = []
let left = matches
for (let g = 0; g < 5 && left.length >= 12; g++) {
  const a = cv.matFromArray(left.length, 1, cv.CV_32FC2, left.flatMap((m) => m.a))
  const b = cv.matFromArray(left.length, 1, cv.CV_32FC2, left.flatMap((m) => m.b))
  const mask = new cv.Mat()
  const H = cv.findHomography(a, b, cv.RANSAC, 4, mask)
  if (H.empty()) break
  const inl = left.filter((_, i) => mask.data[i])
  if (inl.length < 12) break
  groups.push({ H: Array.from(H.data64F as Float64Array), pts: inl })
  left = left.filter((_, i) => !mask.data[i])
  a.delete(), b.delete(), mask.delete(), H.delete()
}
groups.forEach((g, i) => {
  const xs = g.pts.map((m) => m.a[0] / A.k)
  const ys = g.pts.map((m) => m.a[1] / A.k)
  console.log(`  plane ${i + 1}: ${g.pts.length} inliers, source bbox x ${Math.round(Math.min(...xs))}-${Math.round(Math.max(...xs))} y ${Math.round(Math.min(...ys))}-${Math.round(Math.max(...ys))}`)
})
console.log(`  unexplained matches: ${left.length}`)

// Picture: source | target, each plane's matches as coloured dots + lines.
const W = 960
const H = Math.round((src.height * W) / src.width)
const out = new Uint8Array(W * 2 * H * 3)
const put = (img: typeof src, ox: number) => {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (Math.floor((y * img.height) / H) * img.width + Math.floor((x * img.width) / W)) * 4
      const o = (y * W * 2 + x + ox) * 3
      // Dimmed so the overlay reads.
      out[o] = img.data[i] * 0.55
      out[o + 1] = img.data[i + 1] * 0.55
      out[o + 2] = img.data[i + 2] * 0.55
    }
  }
}
put(src, 0)
put(tgt, W)
const COLS = [[255, 220, 0], [0, 220, 255], [255, 90, 200], [120, 255, 90], [255, 150, 40]]
const dot = (x: number, y: number, c: number[]) => {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const px = Math.round(x + dx)
    const py = Math.round(y + dy)
    if (px < 0 || py < 0 || px >= W * 2 || py >= H) continue
    out.set(c, (py * W * 2 + px) * 3)
  }
}
const line = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0))
  for (let t = 0; t <= n; t += 3) {
    const px = Math.round(x0 + ((x1 - x0) * t) / n)
    const py = Math.round(y0 + ((y1 - y0) * t) / n)
    if (px >= 0 && py >= 0 && px < W * 2 && py < H) out.set(c.map((v) => v * 0.6), (py * W * 2 + px) * 3)
  }
}
const toView = (p: [number, number], k: number, img: typeof src) => [((p[0] / k) * W) / img.width, ((p[1] / k) * H) / img.height]
groups.forEach((g, gi) => {
  g.pts.forEach((m, mi) => {
    const [ax, ay] = toView(m.a, A.k, src)
    const [bx, by] = toView(m.b, B.k, tgt)
    if (mi % 3 === 0) line(ax, ay, bx + W, by, COLS[gi])
    dot(ax, ay, COLS[gi])
    dot(bx + W, by, COLS[gi])
  })
})
const file = join(dir, 'captures', 'feature-match.png')
writeFileSync(file, encodePng(W * 2, H, out))
console.log(`wrote ${file}`)
