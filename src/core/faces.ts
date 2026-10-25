/**
 * Faces for Auto: the interviewee's skin is the colour that matters most,
 * and a face is not a plane, so feature matching (features.ts +
 * homography.ts) maps it only roughly, and not at all when one camera sees
 * it small or turned.
 *
 * Two small models, both run by the OpenCV.js that Auto already loads:
 *   - YuNet (OpenCV model zoo, face_detection_yunet_2023mar.onnx, 230 KB)
 *     finds each face: a box, both eyes, the nose tip and the mouth corners.
 *   - MediaPipe's face mesh (face_landmark.tflite, 1.2 MB) places 468
 *     landmarks on a 192×192 crop of each face, rotated level by the eyes.
 *     Landmark n is the same spot on the face in every frame (n 151 is the
 *     middle of the forehead), whatever the camera angle.
 * The cv module and the model bytes are passed in, like features.ts, so
 * scripts can run this under Node.
 */
import type { Pt } from './homography.ts'
import type { RgbaImage } from './sample.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any

export interface FaceModels {
  /** Path of YuNet inside OpenCV's in-memory file system. */
  detector: string
  mesh: any
}

export interface Face {
  /** x, y, width, height in frame pixels. */
  box: [number, number, number, number]
  /** Right eye, left eye (the person's), nose tip, right and left mouth corner. */
  marks: Pt[]
  score: number
}

/** A face's 468 mesh landmarks in frame pixels; z is depth in the same units (smaller is nearer). */
export interface FaceMesh {
  face: Face
  pts: Pt[]
  z: number[]
}

const DETECT_WIDTH = 960
const MESH_SIZE = 192

let fileNo = 0

/** Register the model bytes with OpenCV (once per pair of byte arrays). */
export function loadFaceModels(cv: CV, yunet: Uint8Array, mesh: Uint8Array): FaceModels {
  const id = fileNo++
  const det = `/pm-yunet-${id}.onnx`
  const lm = `/pm-mesh-${id}.tflite`
  cv.FS_createDataFile('/', det.slice(1), yunet, true, false, false)
  cv.FS_createDataFile('/', lm.slice(1), mesh, true, false, false)
  return { detector: det, mesh: cv.readNetFromTFLite(lm) }
}

function toBgr(cv: CV, img: RgbaImage): any {
  const rgba = cv.matFromImageData({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length) })
  const bgr = new cv.Mat()
  cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR)
  rgba.delete()
  return bgr
}

/** Faces in a frame, most confident first. Detection runs at ≤ 960 px wide (1080p takes 0.9 s, this ~0.25 s). */
export function detectFaces(cv: CV, models: FaceModels, img: RgbaImage, minScore = 0.7): Face[] {
  const k = Math.min(1, DETECT_WIDTH / img.width)
  const w = Math.round(img.width * k)
  const h = Math.round(img.height * k)
  const bgr = toBgr(cv, img)
  const small = new cv.Mat()
  cv.resize(bgr, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA)
  bgr.delete()
  const det = new cv.FaceDetectorYN(models.detector, '', new cv.Size(w, h), minScore, 0.3, 50, 0, 0)
  const out = new cv.Mat()
  try {
    det.detect(small, out)
    const faces: Face[] = []
    for (let i = 0; i < out.rows; i++) {
      const r = out.data32F.slice(i * 15, i * 15 + 15)
      const marks: Pt[] = []
      for (let j = 0; j < 5; j++) marks.push([r[4 + 2 * j] / k, r[5 + 2 * j] / k])
      faces.push({ box: [r[0] / k, r[1] / k, r[2] / k, r[3] / k], marks, score: r[14] })
    }
    return faces.sort((a, b) => b.score - a.score)
  } finally {
    small.delete()
    out.delete()
    det.delete()
  }
}

/** One mesh pass on a square crop centred on c, side `size`, turned by `angle` (radians, the eyes' tilt). */
function meshPass(cv: CV, models: FaceModels, bgr: any, c: Pt, size: number, angle: number): { pts: Pt[]; z: number[] } {
  // Crop pixel (u, v) <- frame: rotate by angle about the crop centre, scale size/192.
  const s = size / MESH_SIZE
  const cos = Math.cos(angle) * s
  const sin = Math.sin(angle) * s
  const h = MESH_SIZE / 2
  // Frame = A·crop + t
  const A = [cos, -sin, sin, cos]
  const t = [c[0] - A[0] * h - A[1] * h, c[1] - A[2] * h - A[3] * h]
  const M = cv.matFromArray(2, 3, cv.CV_64F, [A[0], A[1], t[0], A[2], A[3], t[1]])
  const crop = new cv.Mat()
  const rgb = new cv.Mat()
  let blob: any = null
  let res: any = null
  try {
    cv.warpAffine(bgr, crop, M, new cv.Size(MESH_SIZE, MESH_SIZE), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE)
    cv.cvtColor(crop, rgb, cv.COLOR_BGR2RGB)
    blob = cv.blobFromImage(rgb, 1 / 255, new cv.Size(MESH_SIZE, MESH_SIZE), new cv.Scalar(0, 0, 0), false, false)
    models.mesh.setInput(blob)
    res = models.mesh.forward()
    const d = res.data32F
    const pts: Pt[] = []
    const z: number[] = []
    for (let i = 0; i < 468; i++) {
      const u = d[i * 3]
      const v = d[i * 3 + 1]
      pts.push([A[0] * u + A[1] * v + t[0], A[2] * u + A[3] * v + t[1]])
      z.push(d[i * 3 + 2] * s)
    }
    return { pts, z }
  } finally {
    for (const m of [M, crop, rgb, blob, res]) m?.delete()
  }
}

/**
 * The face mesh for a detected face. The first pass crops around YuNet's box
 * (1.5× its long side, as MediaPipe does); the second re-centres on the
 * first pass's landmarks, which is how MediaPipe tracks, and is steadier.
 */
export function faceMesh(cv: CV, models: FaceModels, img: RgbaImage, face: Face): FaceMesh {
  const bgr = toBgr(cv, img)
  try {
    const [re, le] = face.marks
    const angle = Math.atan2(le[1] - re[1], le[0] - re[0])
    const [bx, by, bw, bh] = face.box
    let m = meshPass(cv, models, bgr, [bx + bw / 2, by + bh / 2], 1.5 * Math.max(bw, bh), angle)
    const xs = m.pts.map((p) => p[0])
    const ys = m.pts.map((p) => p[1])
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    // Level by the mesh's own eye corners (33: right outer, 263: left outer).
    const a2 = Math.atan2(m.pts[263][1] - m.pts[33][1], m.pts[263][0] - m.pts[33][0])
    m = meshPass(cv, models, bgr, [(x0 + x1) / 2, (y0 + y1) / 2], 1.5 * Math.max(x1 - x0, y1 - y0), a2)
    return { face, pts: m.pts, z: m.z }
  } finally {
    bgr.delete()
  }
}
