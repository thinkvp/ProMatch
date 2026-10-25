/**
 * Lazy OpenCV.js (11 MB): loaded the first time Auto runs, never at panel
 * start. Inside CEP it is `require`d through Node — a <script> tag would not
 * work there, because --mixed-context defines `module`, so the UMD build
 * would export to module.exports instead of window.cv. In a plain browser it
 * comes in as a script tag.
 */
import { type FaceModels, loadFaceModels } from '../core/faces.ts'
import { readyCv } from '../core/features.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
let loading: Promise<any> | null = null
let faces: Promise<FaceModels> | null = null

function vendorUrl(file = 'opencv.js'): URL {
  return new URL(`vendor/${file}`, window.location.href)
}

/** A vendor/ file's bytes: through Node inside CEP, fetched in a plain browser. */
async function vendorBytes(file: string): Promise<Uint8Array> {
  const url = vendorUrl(file)
  const req = (globalThis as { require?: (id: string) => any }).require
  if (typeof req === 'function' && url.protocol === 'file:') {
    return new Uint8Array(req('fs').readFileSync(decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')))
  }
  const res = await fetch(url.href)
  if (!res.ok) throw new Error(`Could not load vendor/${file}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** The face models (faces.ts, 1.5 MB), loaded into OpenCV the first time Auto runs. */
export function loadFaces(cv: any): Promise<FaceModels> {
  faces ??= (async () => loadFaceModels(cv, await vendorBytes('face_detection_yunet_2023mar.onnx'), await vendorBytes('face_landmark.tflite')))()
  faces.catch(() => (faces = null))
  return faces
}

export function loadOpenCv(): Promise<any> {
  loading ??= (async () => {
    const req = (globalThis as { require?: (id: string) => any }).require
    if (typeof req === 'function' && vendorUrl().protocol === 'file:') {
      // file:///C:/…/vendor/opencv.js -> C:/…/vendor/opencv.js
      const path = decodeURIComponent(vendorUrl().pathname).replace(/^\/([A-Za-z]:)/, '$1')
      return readyCv(req(path))
    }
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script')
      s.src = vendorUrl().href
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('Could not load vendor/opencv.js — run npm run build'))
      document.head.appendChild(s)
    })
    return readyCv((window as any).cv)
  })()
  // A failed load should be retryable, not cached forever.
  loading.catch(() => (loading = null))
  return loading
}
