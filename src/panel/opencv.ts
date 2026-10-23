/**
 * Lazy OpenCV.js (11 MB): loaded the first time Auto runs, never at panel
 * start. Inside CEP it is `require`d through Node — a <script> tag would not
 * work there, because --mixed-context defines `module`, so the UMD build
 * would export to module.exports instead of window.cv. In a plain browser it
 * comes in as a script tag.
 */
import { readyCv } from '../core/features.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
let loading: Promise<any> | null = null

function vendorUrl(): URL {
  return new URL('vendor/opencv.js', window.location.href)
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
