/**
 * Feature matching between the two frames with OpenCV.js (AKAZE). The cv
 * module is passed in, so the panel can lazy-load it only when Auto runs and
 * scripts can load it under Node.
 *
 * Greyscale is contrast-equalised (CLAHE) first: the cameras' exposure and
 * profile differences would otherwise change which corners get detected.
 * Matches are filtered with Lowe's ratio test; geometric filtering happens in
 * homography.ts.
 */
import type { Correspondence } from './homography.ts'
import type { RgbaImage } from './sample.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any

const WORK_WIDTH = 1280

function prepare(cv: CV, img: RgbaImage): { mat: any; k: number } {
  const rgba = cv.matFromImageData({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length) })
  const grey = new cv.Mat()
  cv.cvtColor(rgba, grey, cv.COLOR_RGBA2GRAY)
  rgba.delete()
  const k = Math.min(1, WORK_WIDTH / img.width)
  const small = new cv.Mat()
  cv.resize(grey, small, new cv.Size(Math.round(img.width * k), Math.round(img.height * k)), 0, 0, cv.INTER_AREA)
  grey.delete()
  const eq = new cv.Mat()
  const clahe = new cv.CLAHE(2.5, new cv.Size(8, 8))
  clahe.apply(small, eq)
  clahe.delete()
  small.delete()
  return { mat: eq, k }
}

/** Matched points in full-resolution pixel coordinates of each frame. */
export function matchFeatures(cv: CV, src: RgbaImage, tgt: RgbaImage, ratio = 0.8): Correspondence[] {
  const A = prepare(cv, src)
  const B = prepare(cv, tgt)
  const akaze = new cv.AKAZE()
  akaze.setThreshold(0.0005)
  const kpA = new cv.KeyPointVector()
  const kpB = new cv.KeyPointVector()
  const dA = new cv.Mat()
  const dB = new cv.Mat()
  const none = new cv.Mat()
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false)
  const knn = new cv.DMatchVectorVector()
  const out: Correspondence[] = []
  try {
    akaze.detectAndCompute(A.mat, none, kpA, dA)
    akaze.detectAndCompute(B.mat, none, kpB, dB)
    if (dA.rows < 2 || dB.rows < 2) return out
    bf.knnMatch(dA, dB, knn, 2)
    for (let i = 0; i < knn.size(); i++) {
      const m = knn.get(i)
      if (m.size() < 2) continue
      const m0 = m.get(0)
      const m1 = m.get(1)
      if (m0.distance >= ratio * m1.distance) continue
      const pa = kpA.get(m0.queryIdx).pt
      const pb = kpB.get(m0.trainIdx).pt
      out.push({ a: [pa.x / A.k, pa.y / A.k], b: [pb.x / B.k, pb.y / B.k] })
    }
    return out
  } finally {
    for (const o of [A.mat, B.mat, akaze, kpA, kpB, dA, dB, none, bf, knn]) o.delete()
  }
}

/** Resolve an OpenCV.js module object (some builds export a promise, others a runtime callback). */
export function readyCv(mod: CV): Promise<CV> {
  if (mod?.Mat) return Promise.resolve(mod)
  if (mod && typeof mod.then === 'function' && !(mod instanceof Promise)) {
    // An Emscripten module is "thenable" and resolves to itself; awaiting it
    // directly recurses forever. Take its value and drop the `then`.
    return new Promise((resolve) =>
      mod.then((m: CV) => {
        const real = m ?? mod
        try {
          delete real.then
        } catch {
          // Non-configurable on some builds; resolving below still works once Mat exists.
        }
        resolve(real)
      }),
    )
  }
  if (mod instanceof Promise) return mod.then(readyCv)
  return new Promise((resolve) => (mod.onRuntimeInitialized = () => resolve(mod)))
}
