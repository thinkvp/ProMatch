/**
 * Score match methods on the saved session's real frames, always on points
 * the method did NOT fit on:
 *   - manual: leave-one-out over the session's pairs
 *   - auto: fitted on its own suggestions, scored on every session pair
 *   - auto + a few manual: leave-one-out, auto pairs always in the fit
 * "colour" is Auto v1 (pairs by colour, auto.ts); "geometric" is Auto v2
 * (pairs at the same physical spot, geo-auto.ts, needs OpenCV), with skin
 * pairs from the face models in vendor/ (faces.ts), as the panel runs it.
 * The score is the ΔE between matched target and source at the session's
 * points, measured with the session's disc samples.
 * Run: npx tsx scripts/eval-real.ts   (writes captures/compare-auto.png)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { analyse } from '../src/core/analysis.ts'
import { suggestPairs } from '../src/core/auto.ts'
import { deltaE, encodedToOklab } from '../src/core/color.ts'
import { detectFaces, faceMesh, loadFaceModels } from '../src/core/faces.ts'
import { matchFeatures, readyCv } from '../src/core/features.ts'
import { suggestFromMatches } from '../src/core/geo-auto.ts'
import { applyLutToPixels, bakeLut } from '../src/core/lut.ts'
import { type MatchModel, type PairInput, applyModel, fitMatch } from '../src/core/match.ts'
import { sampleDisc } from '../src/core/sample.ts'
import { encodePng, readPng } from './png.ts'
import { pointRadius } from './session.ts'

const cv = await readyCv(createRequire(import.meta.url)('@techstark/opencv-js'))
const dir = join(process.env.APPDATA!, 'ProMatch')
// EVAL_SESSION=<file> scores a saved point set instead of the live session.
const s = JSON.parse(readFileSync(process.env.EVAL_SESSION ?? join(dir, 'session.json'), 'utf8'))
const src = readPng(s.frames.source.path)
const tgt = readPng(s.frames.target.path)
const pts = s.pairs.filter((p: any) => p.source && p.target && !p.auto)
const manual: PairInput[] = pts.map((p: any) => ({
  source: sampleDisc(src, p.source.x, p.source.y, pointRadius(s, src.width, p.source)),
  target: sampleDisc(tgt, p.target.x, p.target.y, pointRadius(s, tgt.width, p.target)),
}))
const all = manual.map((_, i) => i)
const err = (m: MatchModel | null, i: number) =>
  deltaE(encodedToOklab(m ? applyModel(m, manual[i].target.rgb) : manual[i].target.rgb), encodedToOklab(manual[i].source.rgb))
const mean = (f: (i: number) => number) => all.reduce((a, i) => a + f(i), 0) / all.length
/** Leave-one-out with the first k other manual pairs, plus `extra` always in. */
const loo = (k: number, extra: PairInput[] = []) => mean((i) => err(fitMatch([...manual.filter((_, j) => j !== i).slice(0, k), ...extra]), i))
const toPairs = (g: Array<{ source: { x: number; y: number }; target: { x: number; y: number } }>) =>
  g.map((p) => ({ source: sampleDisc(src, p.source.x, p.source.y, pointRadius(s, src.width, p.source)), target: sampleDisc(tgt, p.target.x, p.target.y, pointRadius(s, tgt.width, p.target)) }))

let t0 = Date.now()
const v1 = suggestPairs(analyse(src), analyse(tgt))
const v1ms = Date.now() - t0
t0 = Date.now()
const matches = matchFeatures(cv, src, tgt)
const models = loadFaceModels(cv, readFileSync('vendor/face_detection_yunet_2023mar.onnx'), readFileSync('vendor/face_landmark.tflite'))
const meshes = (img: typeof src) => detectFaces(cv, models, img).slice(0, 4).map((f) => faceMesh(cv, models, img, f))
const geo = suggestFromMatches(matches, src, tgt, undefined, { source: meshes(src), target: meshes(tgt) })
const v2ms = Date.now() - t0
const v1Pairs = toPairs(v1)
const v2Pairs = toPairs(geo.suggestions)

console.log(`${pts.length} manual points · source ${s.frames.source.label} · target ${s.frames.target.label}`)
console.log(
  `geometric: ${matches.length} matches, planes ${geo.planes.map((p) => p.matches).join('/')}, ${geo.faces} face(s) paired, ${geo.candidates} flat candidates, ${geo.rejected} rejected by consensus, ${v2ms} ms`,
)
console.log(`                               colour Auto   geometric Auto`)
console.log(`  no correction                ΔE ${mean((i) => err(null, i)).toFixed(2)}`)
console.log(`  auto alone                   ${mean((i) => err(fitMatch(v1Pairs), i)).toFixed(2)} (${v1.length}p, ${v1ms}ms)   ${mean((i) => err(fitMatch(v2Pairs), i)).toFixed(2)} (${v2Pairs.length}p)`)
for (const k of [3, 6, pts.length - 1]) {
  console.log(`  manual ${String(k).padStart(2)} (${loo(k).toFixed(2)}) + auto      ${loo(k, v1Pairs).toFixed(2)}          ${loo(k, v2Pairs).toFixed(2)}`)
}

// Side by side: source | target matched by geometric Auto. Each pair gets its
// own colour in both frames, so the correspondence can be checked by eye.
const lut = bakeLut(33, (c) => applyModel(fitMatch(v2Pairs), c))
const after = new Uint8ClampedArray(tgt.data)
applyLutToPixels(lut, after)
const W = 960
const H = Math.round((src.height * W) / src.width)
const out = new Uint8Array(W * 2 * H * 3)
const COLS = [[255, 220, 0], [0, 220, 255], [255, 80, 200], [120, 255, 90], [255, 140, 30], [180, 140, 255], [255, 70, 70], [70, 255, 200], [255, 255, 255], [40, 140, 255]]
const put = (img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }, ox: number, marks: Array<{ x: number; y: number }>) => {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (Math.floor((y * img.height) / H) * img.width + Math.floor((x * img.width) / W)) * 4
      const o = (y * W * 2 + x + ox) * 3
      out[o] = img.data[i]
      out[o + 1] = img.data[i + 1]
      out[o + 2] = img.data[i + 2]
    }
  }
  marks.forEach((m, n) => {
    const mx = Math.round((m.x * W) / img.width)
    const my = Math.round((m.y * H) / img.height)
    for (let a = 0; a < 64; a++) {
      const x = Math.round(mx + 7 * Math.cos((a / 64) * Math.PI * 2))
      const y = Math.round(my + 7 * Math.sin((a / 64) * Math.PI * 2))
      if (x >= 0 && y >= 0 && x < W && y < H) out.set(COLS[n % COLS.length], (y * W * 2 + x + ox) * 3)
    }
  })
}
put(src, 0, geo.suggestions.map((g) => g.source))
put({ width: tgt.width, height: tgt.height, data: after }, W, geo.suggestions.map((g) => g.target))
const file = join(dir, 'captures', 'compare-auto.png')
writeFileSync(file, encodePng(W * 2, H, out))
console.log(`wrote ${file}`)
